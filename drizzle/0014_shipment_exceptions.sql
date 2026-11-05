ALTER TABLE shipments ADD COLUMN failure_reason text, ADD COLUMN failed_at timestamptz,
 ADD COLUMN attempt_number integer NOT NULL DEFAULT 1 CHECK(attempt_number BETWEEN 1 AND 3),
 ADD COLUMN return_state text NOT NULL DEFAULT 'none' CHECK(return_state IN ('none','requested','in_transit','received')),
 ADD COLUMN returned_at timestamptz;
ALTER TABLE shipments ADD CONSTRAINT shipments_failure_reason_check CHECK(failure_reason IS NULL OR failure_reason IN
 ('recipient_unavailable','recipient_refused','address_incorrect','recipient_code_unavailable','package_damaged','vehicle_issue','other'));
ALTER TABLE shipments ADD CONSTRAINT shipments_return_custody_check CHECK(return_state='none' OR (status='failed' AND actual_pickup IS NOT NULL));
ALTER TABLE shipments ADD CONSTRAINT shipments_return_receipt_check CHECK((return_state='received')=(returned_at IS NOT NULL));
CREATE TABLE shipment_exceptions (
 id text PRIMARY KEY REFERENCES shipment_events(id) ON DELETE CASCADE,
 shipment_id text NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 actor_id text NOT NULL, action text NOT NULL CHECK(action IN ('fail','retry','return_request','return_start','return_receive','cancel_failed')),
 reason text CHECK(reason IN ('recipient_unavailable','recipient_refused','address_incorrect','recipient_code_unavailable','package_damaged','vehicle_issue','other')),
 note text NOT NULL CHECK(length(note)<=1000), version integer NOT NULL CHECK(version>0),
 attempt_number integer NOT NULL CHECK(attempt_number BETWEEN 1 AND 3), created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT shipment_exceptions_version_unique UNIQUE(shipment_id,version)
);
DROP INDEX shipments_driver_active_page_idx;
CREATE INDEX shipments_driver_active_page_idx ON shipments(driver_id,business_id,created_at DESC,id COLLATE "C" DESC)
 WHERE status NOT IN ('delivered','failed','cancelled') OR (status='failed' AND actual_pickup IS NOT NULL AND return_state<>'received');
CREATE INDEX shipments_held_packages_idx ON shipments((coalesce(failed_at,created_at))) WHERE status='failed' AND actual_pickup IS NOT NULL AND return_state<>'received';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION advance_shipment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.version:=OLD.version;
 IF NEW.status IS DISTINCT FROM OLD.status OR NEW.driver_id IS DISTINCT FROM OLD.driver_id OR NEW.recipient_email IS DISTINCT FROM OLD.recipient_email
   OR NEW.return_state IS DISTINCT FROM OLD.return_state OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number THEN NEW.version:=OLD.version+1; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION protect_shipment_custody() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='failed' AND OLD.status<>'failed' AND (NEW.failure_reason IS NULL OR NEW.failed_at IS NULL) THEN
  RAISE EXCEPTION 'Structured failure reason required' USING ERRCODE='23514';
 END IF;
 IF OLD.actual_pickup IS NOT NULL AND OLD.status NOT IN ('delivered','cancelled') AND OLD.return_state<>'received' AND
  (NEW.status IN ('pending','assigned','cancelled') OR NEW.driver_id IS DISTINCT FROM OLD.driver_id OR NEW.actual_pickup IS NULL) THEN
  RAISE EXCEPTION 'Package custody must be preserved until return receipt' USING ERRCODE='23514';
 END IF;
 IF OLD.return_state='received' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.return_state IS DISTINCT FROM OLD.return_state
   OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number) THEN
  RAISE EXCEPTION 'Returned shipment cannot be reopened' USING ERRCODE='23514';
 END IF;
 IF OLD.status='failed' AND NEW.status IN ('pending','picked_up') AND
   (OLD.return_state<>'none' OR OLD.attempt_number>=3 OR NEW.attempt_number<>OLD.attempt_number+1) THEN
  RAISE EXCEPTION 'Retry must advance a bounded attempt' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER shipments_protect_custody BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION protect_shipment_custody();
ALTER TABLE idempotency_requests DROP CONSTRAINT idempotency_requests_operation_check;
ALTER TABLE idempotency_requests ADD CONSTRAINT idempotency_requests_operation_check CHECK(operation IN
 ('shipments.create','payments.initialize','shipments.update','delivery.issue','delivery.confirm','shipments.exception'));
ALTER FUNCTION execute_shipment_command(text,text,text,text,text,jsonb,text) RENAME TO execute_shipment_command_delivery;
CREATE FUNCTION execute_shipment_command(request_id text,actor_id text,actor_role text,key_digest text,body_digest text,command jsonb,history_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF actor_role='driver' AND command->>'status'='pending' THEN RETURN jsonb_build_object('error','FORBIDDEN','status',403); END IF;
 IF command->>'status' IN ('failed','pending') AND NOT EXISTS(SELECT 1 FROM idempotency_requests WHERE user_id=actor_id
   AND operation='shipments.update' AND key_hash=key_digest AND request_hash=body_digest AND state='completed') THEN
  RETURN jsonb_build_object('error','USE_EXCEPTION_ENDPOINT','status',422);
 END IF;
 RETURN execute_shipment_command_delivery(request_id,actor_id,actor_role,key_digest,body_digest,command,history_id);
END $$;
--> statement-breakpoint
CREATE FUNCTION execute_shipment_exception(request_id text,actor_id text,actor_role text,key_digest text,body_digest text,command jsonb,history_id text)
RETURNS jsonb LANGUAGE plpgsql SET lock_timeout='2s' AS $$
DECLARE s shipments%ROWTYPE; r idempotency_requests%ROWTYPE; a text; notification_status text; message text;
BEGIN
 a:=command->>'action';
 SELECT s0.* INTO s FROM shipments s0 JOIN users u ON u.id=actor_id AND u.is_active AND u.role::text=actor_role
  WHERE s0.id=command->>'shipmentId' AND ((actor_role='business' AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=s0.business_id AND b.user_id=actor_id))
   OR (actor_role='driver' AND EXISTS(SELECT 1 FROM drivers d WHERE d.id=s0.driver_id AND d.business_id=s0.business_id AND d.user_id=actor_id)));
 IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND','status',404); END IF;
 IF a NOT IN ('fail','retry','return_request','return_start','return_receive','cancel_failed') OR
  (actor_role='driver' AND a NOT IN ('fail','return_start')) OR (actor_role='business' AND a='return_start') THEN
  RETURN jsonb_build_object('error','FORBIDDEN','status',403);
 END IF;
 INSERT INTO idempotency_requests(id,user_id,operation,key_hash,request_hash,resource_id,parameters)
  VALUES(request_id,actor_id,'shipments.exception',key_digest,body_digest,s.id,command) ON CONFLICT(user_id,operation,key_hash) DO NOTHING;
 SELECT * INTO STRICT r FROM idempotency_requests WHERE user_id=actor_id AND operation='shipments.exception' AND key_hash=key_digest FOR UPDATE;
 SELECT * INTO s FROM shipments WHERE id=s.id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=actor_id AND u.is_active AND u.role::text=actor_role) OR NOT (
  (actor_role='business' AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=s.business_id AND b.user_id=actor_id)) OR
  (actor_role='driver' AND EXISTS(SELECT 1 FROM drivers d WHERE d.id=s.driver_id AND d.business_id=s.business_id AND d.user_id=actor_id))) THEN
  IF r.state='pending' THEN DELETE FROM idempotency_requests WHERE id=r.id; END IF;
  RETURN jsonb_build_object('error','NOT_FOUND','status',404);
 END IF;
 IF r.request_hash<>body_digest THEN RETURN jsonb_build_object('error','IDEMPOTENCY_KEY_CONFLICT','status',409); END IF;
 IF r.expires_at<=statement_timestamp() OR r.parameters IS NULL THEN RETURN jsonb_build_object('error','IDEMPOTENCY_EXPIRED','status',410); END IF;
 IF r.state='completed' THEN RETURN jsonb_build_object('response',r.response,'replayed',true); END IF;
 IF s.version<>(command->>'expectedVersion')::integer THEN DELETE FROM idempotency_requests WHERE id=r.id;
  RETURN jsonb_build_object('error','SHIPMENT_VERSION_CONFLICT','status',409); END IF;
 IF NOT ((a='fail' AND s.status IN ('assigned','picked_up','in_transit','out_for_delivery') AND s.return_state='none') OR
  (a='retry' AND s.status='failed' AND s.return_state='none' AND s.attempt_number<3 AND
   (s.actual_pickup IS NULL OR EXISTS(SELECT 1 FROM drivers d JOIN users u ON u.id=d.user_id AND u.is_active AND u.role='driver' WHERE d.id=s.driver_id AND d.business_id=s.business_id))) OR
  (a='return_request' AND s.status='failed' AND s.return_state='none' AND s.actual_pickup IS NOT NULL AND s.driver_id IS NOT NULL) OR
  (a='return_start' AND s.status='failed' AND s.return_state='requested') OR
  (a='return_receive' AND s.status='failed' AND s.return_state IN ('requested','in_transit')) OR
  (a='cancel_failed' AND s.status='failed' AND s.return_state='none' AND s.actual_pickup IS NULL)) THEN
  DELETE FROM idempotency_requests WHERE id=r.id; RETURN jsonb_build_object('error','INVALID_EXCEPTION_TRANSITION','status',422);
 END IF;
 IF a='fail' AND (command->>'reason' IS NULL OR command->>'reason' NOT IN
  ('recipient_unavailable','recipient_refused','address_incorrect','recipient_code_unavailable','package_damaged','vehicle_issue','other')) THEN
  DELETE FROM idempotency_requests WHERE id=r.id; RETURN jsonb_build_object('error','INVALID_FAILURE_REASON','status',422);
 END IF;
 UPDATE shipments SET
  status=CASE WHEN a='fail' THEN 'failed'::shipment_status WHEN a='retry' THEN CASE WHEN actual_pickup IS NULL THEN 'pending'::shipment_status ELSE 'picked_up'::shipment_status END
   WHEN a='cancel_failed' THEN 'cancelled'::shipment_status ELSE status END,
  failure_reason=CASE WHEN a='fail' THEN command->>'reason' WHEN a='retry' THEN NULL ELSE failure_reason END,
  failed_at=CASE WHEN a='fail' THEN statement_timestamp() WHEN a IN ('retry','cancel_failed') THEN NULL ELSE failed_at END,
  attempt_number=CASE WHEN a='retry' THEN attempt_number+1 ELSE attempt_number END,
  driver_id=CASE WHEN a='retry' AND actual_pickup IS NULL THEN NULL ELSE driver_id END,
  return_state=CASE a WHEN 'return_request' THEN 'requested' WHEN 'return_start' THEN 'in_transit' WHEN 'return_receive' THEN 'received' ELSE return_state END,
  returned_at=CASE WHEN a='return_receive' THEN statement_timestamp() ELSE returned_at END,
  actual_delivery=CASE WHEN a='retry' THEN NULL ELSE actual_delivery END,
  current_location=CASE WHEN (a='retry' AND actual_pickup IS NULL) OR a IN ('return_receive','cancel_failed') THEN NULL ELSE current_location END,
  updated_at=statement_timestamp() WHERE id=s.id RETURNING * INTO s;
 UPDATE delivery_confirmations SET revoked_at=statement_timestamp() WHERE shipment_id=s.id AND consumed_at IS NULL AND revoked_at IS NULL;
 message:=CASE a WHEN 'fail' THEN 'Delivery attempt failed' WHEN 'retry' THEN 'Business authorized another delivery attempt'
  WHEN 'return_request' THEN 'Return to business requested' WHEN 'return_start' THEN 'Driver returning package to business'
  WHEN 'return_receive' THEN 'Business confirmed return receipt' ELSE 'Business cancelled before pickup' END;
 INSERT INTO shipment_events(id,shipment_id,status,message) VALUES(history_id,s.id,s.status,message);
 INSERT INTO shipment_exceptions(id,shipment_id,actor_id,action,reason,note,version,attempt_number)
  VALUES(history_id,s.id,actor_id,a,CASE WHEN a='fail' THEN command->>'reason' ELSE NULL END,coalesce(command->>'note',''),s.version,s.attempt_number);
 notification_status:=CASE a WHEN 'fail' THEN 'failed' WHEN 'retry' THEN 'delivery_retry' WHEN 'return_request' THEN 'return_requested'
   WHEN 'return_start' THEN 'return_in_transit' WHEN 'return_receive' THEN 'return_received' ELSE 'cancelled' END;
 UPDATE notification_outbox SET payload=jsonb_set(payload,'{status}',to_jsonb(notification_status))
  WHERE id IN ('shipment_'||history_id||'_business','shipment_'||history_id||'_customer','shipment_'||history_id||'_email');
 UPDATE idempotency_requests SET response=to_jsonb(s),state='completed' WHERE id=r.id;
 RETURN jsonb_build_object('response',to_jsonb(s),'replayed',false);
END $$;
