CREATE TABLE notification_outbox (
  id text PRIMARY KEY,
  shipment_id text NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app','email')),
  kind text NOT NULL CHECK (kind IN ('shipment_status','payment_confirmed')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','delivered','skipped','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT notification_outbox_lease CHECK (
    (state = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
    (state <> 'processing' AND lease_token IS NULL AND lease_until IS NULL))
);
--> statement-breakpoint
CREATE INDEX notification_outbox_due_idx ON notification_outbox(state, available_at);
--> statement-breakpoint
CREATE INDEX notification_outbox_lease_idx ON notification_outbox(state, lease_until);
--> statement-breakpoint
CREATE INDEX notification_outbox_completed_idx ON notification_outbox(completed_at);
--> statement-breakpoint
CREATE INDEX notification_outbox_shipment_idx ON notification_outbox(shipment_id);
--> statement-breakpoint
CREATE INDEX notification_outbox_recipient_idx ON notification_outbox(recipient_id);
--> statement-breakpoint
CREATE FUNCTION capture_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment shipments%ROWTYPE;
  owner_id text;
  event_id text;
  event_kind text;
  event_status text;
  body jsonb;
  amount integer;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    IF NEW.status <> 'success' OR OLD.status = 'success' THEN RETURN NEW; END IF;
    event_id := 'payment_' || NEW.id;
    event_kind := 'payment_confirmed';
    event_status := 'paid';
    amount := NEW.amount_kobo;
  ELSE
    event_id := 'shipment_' || NEW.id;
    event_kind := 'shipment_status';
    event_status := NEW.status::text;
  END IF;
  SELECT * INTO STRICT shipment FROM shipments WHERE id = NEW.shipment_id;
  IF event_kind = 'shipment_status' THEN amount := shipment.price_kobo; END IF;
  SELECT user_id INTO STRICT owner_id FROM businesses WHERE id = shipment.business_id;
  body := jsonb_build_object('trackingId', shipment.tracking_id, 'status', event_status,
    'businessId', shipment.business_id, 'ownerId', owner_id, 'customerId', shipment.customer_id,
    'amountKobo', amount);
  INSERT INTO notification_outbox(id,shipment_id,recipient_id,channel,kind,payload)
    VALUES(event_id || '_business', shipment.id, owner_id, 'in_app', event_kind, body)
    ON CONFLICT(id) DO NOTHING;
  IF shipment.customer_id IS NOT NULL THEN
    INSERT INTO notification_outbox(id,shipment_id,recipient_id,channel,kind,payload)
      VALUES(event_id || '_customer', shipment.id, shipment.customer_id, 'in_app', event_kind, body)
      ON CONFLICT(id) DO NOTHING;
    IF event_kind = 'payment_confirmed' OR event_status IN ('assigned','picked_up','delivered','failed') THEN
      INSERT INTO notification_outbox(id,shipment_id,recipient_id,channel,kind,payload)
        VALUES(event_id || '_email', shipment.id, shipment.customer_id, 'email', event_kind, body)
        ON CONFLICT(id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shipment_event_outbox AFTER INSERT ON shipment_events
FOR EACH ROW EXECUTE FUNCTION capture_notification_event();
--> statement-breakpoint
CREATE TRIGGER payment_confirmation_outbox AFTER UPDATE OF status ON payments
FOR EACH ROW EXECUTE FUNCTION capture_notification_event();
