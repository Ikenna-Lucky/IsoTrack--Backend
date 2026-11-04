ALTER TABLE shipments ADD COLUMN recipient_email text;
CREATE TABLE delivery_confirmations (
 id text PRIMARY KEY, shipment_id text NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 driver_id text NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
 shipment_version integer NOT NULL CHECK(shipment_version>=0), email text NOT NULL,
 code_hash text NOT NULL CHECK(length(code_hash)=64), failures integer NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, confirmed_by text, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 delivery_state text NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','processing','sent','skipped','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5), available_at timestamptz NOT NULL DEFAULT now(),
 lease_token text, lease_until timestamptz,
 CONSTRAINT delivery_confirmation_expiry CHECK(expires_at>created_at),
 CONSTRAINT delivery_confirmation_lease CHECK((delivery_state='processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
   (delivery_state<>'processing' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX delivery_confirmations_shipment_idx ON delivery_confirmations(shipment_id,created_at DESC);
CREATE INDEX delivery_confirmations_due_idx ON delivery_confirmations(available_at) WHERE delivery_state='pending';
CREATE INDEX delivery_confirmations_lease_idx ON delivery_confirmations(lease_until) WHERE delivery_state='processing';
CREATE INDEX delivery_confirmations_expiry_idx ON delivery_confirmations(expires_at);
CREATE INDEX delivery_confirmations_dead_idx ON delivery_confirmations(available_at) WHERE delivery_state='dead';
CREATE UNIQUE INDEX delivery_confirmations_active_idx ON delivery_confirmations(shipment_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;
ALTER TABLE idempotency_requests DROP CONSTRAINT idempotency_requests_operation_check;
ALTER TABLE idempotency_requests ADD CONSTRAINT idempotency_requests_operation_check CHECK(operation IN
 ('shipments.create','payments.initialize','shipments.update','delivery.issue','delivery.confirm'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION advance_shipment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.version:=OLD.version;
 IF NEW.status IS DISTINCT FROM OLD.status OR NEW.driver_id IS DISTINCT FROM OLD.driver_id OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email THEN
  NEW.version:=OLD.version+1;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION require_delivery_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status='delivered' THEN RAISE EXCEPTION 'Delivery confirmation required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status='delivered' AND OLD.status<>'delivered' THEN
  IF OLD.status<>'out_for_delivery' OR NOT EXISTS(SELECT 1 FROM delivery_confirmations d WHERE d.shipment_id=OLD.id
    AND d.shipment_version=OLD.version AND d.driver_id=OLD.driver_id AND d.email=OLD.recipient_email
    AND d.consumed_at IS NOT NULL AND d.revoked_at IS NULL) THEN
   RAISE EXCEPTION 'Delivery confirmation required' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipments_require_delivery BEFORE INSERT OR UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION require_delivery_confirmation();
ALTER FUNCTION execute_shipment_command(text,text,text,text,text,jsonb,text) RENAME TO execute_shipment_command_legacy;
CREATE FUNCTION execute_shipment_command(request_id text,actor_id text,actor_role text,key_digest text,body_digest text,command jsonb,history_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF command->>'status'='delivered' AND NOT EXISTS(SELECT 1 FROM idempotency_requests WHERE user_id=actor_id
   AND operation='shipments.update' AND key_hash=key_digest AND request_hash=body_digest AND state='completed') THEN
  RETURN jsonb_build_object('error','DELIVERY_CONFIRMATION_REQUIRED','status',422);
 END IF;
 RETURN execute_shipment_command_legacy(request_id,actor_id,actor_role,key_digest,body_digest,command,history_id);
END $$;
--> statement-breakpoint
CREATE FUNCTION delivery_command(request_id text,actor_id text,actor_role text,key_digest text,body_digest text,
 command jsonb,challenge_id text,proof_digest text,event_id text)
RETURNS jsonb LANGUAGE plpgsql SET lock_timeout='2s' AS $$
DECLARE s shipments%ROWTYPE; r idempotency_requests%ROWTYPE; d delivery_confirmations%ROWTYPE; op text; result jsonb; n integer;
BEGIN
 op:=CASE WHEN command->>'action'='issue' THEN 'delivery.issue' ELSE 'delivery.confirm' END;
 SELECT s0.* INTO s FROM shipments s0 JOIN users u ON u.id=actor_id AND u.is_active AND u.role::text=actor_role
 WHERE s0.id=command->>'shipmentId' AND (
  (op='delivery.issue' AND actor_role='business' AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=s0.business_id AND b.user_id=actor_id)) OR
  (op='delivery.confirm' AND actor_role='driver' AND EXISTS(SELECT 1 FROM drivers dr WHERE dr.id=s0.driver_id AND dr.business_id=s0.business_id AND dr.user_id=actor_id)));
 IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND','status',404); END IF;
 INSERT INTO idempotency_requests(id,user_id,operation,key_hash,request_hash,resource_id,parameters)
 VALUES(request_id,actor_id,op,key_digest,body_digest,s.id,command) ON CONFLICT(user_id,operation,key_hash) DO NOTHING;
 SELECT * INTO STRICT r FROM idempotency_requests WHERE user_id=actor_id AND operation=op AND key_hash=key_digest FOR UPDATE;
 SELECT * INTO s FROM shipments WHERE id=s.id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=actor_id AND u.is_active AND u.role::text=actor_role) OR NOT (
  (op='delivery.issue' AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=s.business_id AND b.user_id=actor_id)) OR
  (op='delivery.confirm' AND EXISTS(SELECT 1 FROM drivers dr WHERE dr.id=s.driver_id AND dr.business_id=s.business_id AND dr.user_id=actor_id))) THEN
  IF r.state='pending' THEN DELETE FROM idempotency_requests WHERE id=r.id; END IF;
  RETURN jsonb_build_object('error','NOT_FOUND','status',404);
 END IF;
 IF r.request_hash<>body_digest THEN RETURN jsonb_build_object('error','IDEMPOTENCY_KEY_CONFLICT','status',409); END IF;
 IF r.expires_at<=statement_timestamp() OR r.parameters IS NULL THEN RETURN jsonb_build_object('error','IDEMPOTENCY_EXPIRED','status',410); END IF;
 IF r.state='completed' THEN RETURN jsonb_build_object('response',r.response,'replayed',true); END IF;
 IF s.version<>(command->>'expectedVersion')::integer OR s.status<>'out_for_delivery' OR s.driver_id IS NULL THEN
  DELETE FROM idempotency_requests WHERE id=r.id;
  RETURN jsonb_build_object('error','SHIPMENT_VERSION_CONFLICT','status',409);
 END IF;
 IF op='delivery.issue' THEN
  IF NOT EXISTS(SELECT 1 FROM drivers dr JOIN users u ON u.id=dr.user_id AND u.is_active AND u.role='driver'
    WHERE dr.id=s.driver_id AND dr.business_id=s.business_id) THEN
   DELETE FROM idempotency_requests WHERE id=r.id; RETURN jsonb_build_object('error','DRIVER_UNAVAILABLE','status',409);
  END IF;
  IF EXISTS(SELECT 1 FROM delivery_confirmations WHERE shipment_id=s.id AND created_at>statement_timestamp()-interval '1 minute') OR
    (SELECT count(*) FROM delivery_confirmations WHERE shipment_id=s.id AND created_at>statement_timestamp()-interval '1 hour')>=3 THEN
   DELETE FROM idempotency_requests WHERE id=r.id; RETURN jsonb_build_object('error','DELIVERY_RATE_LIMIT','status',409);
  END IF;
  -- Reuse the durable budget store, with a distinct business-scoped namespace.
  INSERT INTO account_action_limits(key,window_start,count,next_at)
   VALUES('delivery-business:'||actor_id,date_trunc('hour',statement_timestamp()),1,statement_timestamp())
   ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,
    count=CASE WHEN account_action_limits.window_start<excluded.window_start THEN 1 ELSE account_action_limits.count+1 END
   WHERE account_action_limits.window_start<excluded.window_start OR account_action_limits.count<60 RETURNING count INTO n;
  IF NOT FOUND THEN DELETE FROM idempotency_requests WHERE id=r.id; RETURN jsonb_build_object('error','DELIVERY_RATE_LIMIT','status',409); END IF;
  UPDATE shipments SET recipient_email=command->>'recipientEmail',updated_at=statement_timestamp() WHERE id=s.id RETURNING * INTO s;
  UPDATE delivery_confirmations SET revoked_at=statement_timestamp() WHERE shipment_id=s.id AND consumed_at IS NULL AND revoked_at IS NULL;
  INSERT INTO delivery_confirmations(id,shipment_id,driver_id,shipment_version,email,code_hash,expires_at)
   VALUES(challenge_id,s.id,s.driver_id,s.version,s.recipient_email,proof_digest,statement_timestamp()+interval '20 minutes');
  result:=jsonb_build_object('challengeId',challenge_id,'version',s.version,'expiresAt',statement_timestamp()+interval '20 minutes');
 ELSE
  SELECT * INTO d FROM delivery_confirmations WHERE id=command->>'challengeId' AND shipment_id=s.id FOR UPDATE;
  IF NOT FOUND OR d.revoked_at IS NOT NULL OR d.consumed_at IS NOT NULL OR d.expires_at<=statement_timestamp()
    OR d.failures>=5 OR d.shipment_version<>s.version OR d.driver_id<>s.driver_id OR d.email IS DISTINCT FROM s.recipient_email THEN
   DELETE FROM idempotency_requests WHERE id=r.id; RETURN jsonb_build_object('error','DELIVERY_CODE_UNAVAILABLE','status',409);
  END IF;
  IF d.code_hash<>proof_digest THEN
   UPDATE delivery_confirmations SET failures=failures+1 WHERE id=d.id;
   result:=jsonb_build_object('error','INVALID_DELIVERY_CODE','status',422);
  ELSE
   UPDATE delivery_confirmations SET consumed_at=statement_timestamp(),confirmed_by=actor_id WHERE id=d.id;
   UPDATE shipments SET status='delivered',actual_delivery=statement_timestamp(),updated_at=statement_timestamp() WHERE id=s.id RETURNING * INTO s;
   INSERT INTO shipment_events(id,shipment_id,status,message) VALUES(event_id,s.id,s.status,'Delivery confirmed by recipient code');
   result:=jsonb_build_object('shipment',to_jsonb(s));
  END IF;
 END IF;
 UPDATE idempotency_requests SET state='completed',response=result WHERE id=r.id;
 RETURN jsonb_build_object('response',result,'replayed',false);
END $$;
