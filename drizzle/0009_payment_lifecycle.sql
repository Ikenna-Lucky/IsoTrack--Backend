ALTER TABLE payments ADD COLUMN checkout_state text NOT NULL DEFAULT 'untracked';
CREATE INDEX idempotency_requests_resource_idx ON idempotency_requests(resource_id);
ALTER TABLE payments ADD COLUMN received_at timestamptz;
ALTER TABLE payments ADD COLUMN review_reason text;
ALTER TABLE payments ADD COLUMN refund_id text;
ALTER TABLE payments ADD CONSTRAINT payments_refund_id_unique UNIQUE(refund_id);
ALTER TABLE payments ADD COLUMN refund_recorded_by text;
ALTER TABLE payments ADD COLUMN refund_recorded_at timestamptz;
ALTER TABLE payments ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT now();
ALTER TABLE payments ADD COLUMN reconcile_token text;
ALTER TABLE payments ADD COLUMN reconcile_until timestamptz;
ALTER TABLE payments ADD CONSTRAINT payments_checkout_state_check CHECK
  (checkout_state IN ('untracked','creating','open','processing','expired','failed','settled','review'));
CREATE INDEX payments_reconciliation_idx ON payments(reconcile_after)
  WHERE provider='stripe' AND status='pending' AND checkout_state<>'review';
--> statement-breakpoint
CREATE TABLE payment_checkout_guards (
  shipment_id text PRIMARY KEY CONSTRAINT payment_checkout_guards_shipment_id_shipments_id_fk REFERENCES shipments(id) ON DELETE RESTRICT,
  payment_id text CONSTRAINT payment_checkout_guards_payment_id_payments_id_fk REFERENCES payments(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_checkout_guards_payment_idx ON payment_checkout_guards(payment_id);
-- Existing pending attempts cannot safely be discarded: an unattached attempt
-- may already exist at Stripe. Quarantine the shipment until reconciled.
INSERT INTO payment_checkout_guards(shipment_id)
SELECT DISTINCT shipment_id FROM payments WHERE provider='stripe' AND status='pending';
UPDATE payments SET checkout_state=CASE WHEN status='success' THEN 'settled' ELSE 'untracked' END;
CREATE TABLE shipment_payment_receipts (
  shipment_id text PRIMARY KEY CONSTRAINT shipment_payment_receipts_shipment_id_shipments_id_fk REFERENCES shipments(id) ON DELETE RESTRICT,
  payment_id text NOT NULL CONSTRAINT shipment_payment_receipts_payment_id_unique UNIQUE
    CONSTRAINT shipment_payment_receipts_payment_id_payments_id_fk REFERENCES payments(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO shipment_payment_receipts(shipment_id,payment_id)
SELECT DISTINCT ON (shipment_id) shipment_id,id FROM payments WHERE status='success'
ORDER BY shipment_id,paid_at NULLS LAST,created_at,id;
UPDATE shipments s SET is_paid=true,updated_at=statement_timestamp()
WHERE NOT s.is_paid AND EXISTS(SELECT 1 FROM shipment_payment_receipts r WHERE r.shipment_id=s.id);
UPDATE payments p SET review_reason='legacy_additional_payment',received_at=coalesce(p.paid_at,p.created_at)
WHERE p.status='success' AND NOT EXISTS(SELECT 1 FROM shipment_payment_receipts r WHERE r.payment_id=p.id);
--> statement-breakpoint
CREATE FUNCTION prepare_payment_checkout(request_id text, actor_id text, actor_role text, token text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r record; s record; guard record;
BEGIN
  SELECT * INTO r FROM idempotency_requests WHERE id=request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Always lock the shipment before touching a payment. Separate statements
  -- after the lock see the winner of a concurrent transaction under READ COMMITTED.
  SELECT * INTO s FROM shipments WHERE id=r.parameters->>'shipmentId' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO r FROM idempotency_requests WHERE id=request_id FOR UPDATE;
  IF r.user_id<>actor_id OR r.operation<>'payments.initialize' OR r.state<>'pending'
    OR r.lease_token IS DISTINCT FROM token OR r.lease_until<=statement_timestamp()
    OR r.expires_at<=statement_timestamp()
    OR r.created_at+interval '23 hours'<=statement_timestamp()
    OR NOT EXISTS(SELECT 1 FROM users WHERE id=actor_id AND is_active AND role::text=actor_role)
    OR ((actor_role='customer' AND s.customer_id=actor_id) OR
      (actor_role='business' AND EXISTS(SELECT 1 FROM businesses WHERE id=s.business_id AND user_id=actor_id))) IS NOT TRUE
    OR s.is_paid OR EXISTS(SELECT 1 FROM shipment_payment_receipts WHERE shipment_id=s.id)
    OR s.status IN ('cancelled','failed') OR s.price_kobo<>(r.parameters->>'amountKobo')::integer
    THEN RETURN NULL; END IF;
  SELECT * INTO guard FROM payment_checkout_guards WHERE shipment_id=s.id;
  IF FOUND AND guard.payment_id IS DISTINCT FROM r.resource_id THEN RETURN jsonb_build_object('blocked',true); END IF;
  IF EXISTS(SELECT 1 FROM payments WHERE id=r.resource_id AND (status<>'pending' OR checkout_state NOT IN ('creating','open')
    OR shipment_id<>s.id OR provider<>'stripe' OR provider_reference IS DISTINCT FROM r.parameters->>'reference'
    OR amount_kobo<>(r.parameters->>'amountKobo')::integer))
    THEN RETURN NULL; END IF;
  INSERT INTO payments(id,shipment_id,provider_reference,provider,amount_kobo,status,checkout_state)
    VALUES(r.resource_id,s.id,r.parameters->>'reference','stripe',(r.parameters->>'amountKobo')::integer,'pending','creating')
    ON CONFLICT(id) DO NOTHING;
  INSERT INTO payment_checkout_guards(shipment_id,payment_id) VALUES(s.id,r.resource_id) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('id',r.resource_id);
END $$;
--> statement-breakpoint
CREATE FUNCTION confirm_stripe_payment(ref text, session_id text, amount integer, currency_code text, payment_channel text, receipt_time timestamptz)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; s shipments%ROWTYPE; applied text;
BEGIN
  SELECT * INTO p FROM payments WHERE provider_reference=ref AND provider='stripe';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO s FROM shipments WHERE id=p.shipment_id FOR UPDATE;
  SELECT * INTO p FROM payments WHERE id=p.id FOR UPDATE;
  IF (p.stripe_session_id IS NOT NULL AND p.stripe_session_id<>session_id) OR p.amount_kobo<>amount
    OR currency_code<>'NGN' OR (p.status NOT IN ('pending','success') AND NOT (p.status='failed' AND p.checkout_state IN ('expired','failed'))) THEN RETURN NULL; END IF;
  IF p.status='success' THEN RETURN p.id; END IF;
  SELECT payment_id INTO applied FROM shipment_payment_receipts WHERE shipment_id=s.id;
  IF p.checkout_state='review' THEN RETURN p.id; END IF;
  IF applied IS NOT NULL OR s.is_paid OR s.status IN ('cancelled','failed') OR s.price_kobo<>amount THEN
    UPDATE payments SET status='pending',stripe_session_id=session_id,checkout_state='review',received_at=receipt_time,
      review_reason=CASE WHEN applied IS NOT NULL OR s.is_paid THEN 'additional_payment'
        WHEN s.price_kobo<>amount THEN 'price_changed' ELSE 'shipment_not_payable' END,
      channel=payment_channel,updated_at=statement_timestamp() WHERE id=p.id;
  ELSE
    INSERT INTO shipment_payment_receipts(shipment_id,payment_id) VALUES(s.id,p.id);
    UPDATE payments SET status='success',stripe_session_id=session_id,checkout_state='settled',received_at=receipt_time,
      paid_at=receipt_time,channel=payment_channel,updated_at=statement_timestamp() WHERE id=p.id;
    UPDATE shipments SET is_paid=true,updated_at=statement_timestamp() WHERE id=s.id;
  END IF;
  -- Keep a different open checkout guarded until Stripe confirms expiration.
  IF EXISTS(SELECT 1 FROM payments WHERE id=p.id AND checkout_state='settled') THEN
    DELETE FROM payment_checkout_guards WHERE shipment_id=s.id AND payment_id=p.id;
  END IF;
  RETURN p.id;
END $$;
--> statement-breakpoint
CREATE FUNCTION close_stripe_checkout(ref text, session_id text, amount integer, closed_state text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE;
BEGIN
  IF closed_state NOT IN ('expired','failed') THEN RETURN false; END IF;
  SELECT * INTO p FROM payments WHERE provider_reference=ref AND provider='stripe';
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM shipments WHERE id=p.shipment_id FOR UPDATE;
  SELECT * INTO p FROM payments WHERE id=p.id FOR UPDATE;
  IF p.status<>'pending' OR p.checkout_state='review' OR p.amount_kobo<>amount
    OR (p.stripe_session_id IS NOT NULL AND p.stripe_session_id<>session_id) THEN RETURN false; END IF;
  UPDATE payments SET stripe_session_id=session_id,checkout_state=closed_state,status='failed',updated_at=statement_timestamp() WHERE id=p.id;
  DELETE FROM payment_checkout_guards WHERE shipment_id=p.shipment_id AND payment_id=p.id;
  -- A legacy guard has no single owner. Release only after every uncertain
  -- legacy attempt has reached a terminal state without a review balance.
  DELETE FROM payment_checkout_guards g WHERE g.shipment_id=p.shipment_id AND g.payment_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM payments x WHERE x.shipment_id=p.shipment_id AND x.provider='stripe' AND x.status='pending');
  RETURN true;
END $$;
