ALTER TABLE shipments ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK (version >= 0);
--> statement-breakpoint
CREATE FUNCTION advance_shipment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipments_advance_version BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION advance_shipment_version();
--> statement-breakpoint
ALTER TABLE idempotency_requests DROP CONSTRAINT idempotency_requests_operation_check;
ALTER TABLE idempotency_requests ADD CONSTRAINT idempotency_requests_operation_check
  CHECK (operation IN ('shipments.create','payments.initialize','shipments.update'));
--> statement-breakpoint
CREATE FUNCTION execute_shipment_command(request_id text, actor_id text, actor_role text,
  key_digest text, body_digest text, command jsonb, history_id text)
RETURNS jsonb LANGUAGE plpgsql SET lock_timeout='2s' AS $$
DECLARE s shipments%ROWTYPE; r idempotency_requests%ROWTYPE; target_status shipment_status; message text;
BEGIN
  -- Always authorize current access, including before returning saved snapshots.
  SELECT s0.* INTO s FROM shipments s0 JOIN users u ON u.id=actor_id AND u.is_active AND u.role::text=actor_role
    WHERE s0.id=command->>'shipmentId' AND (
      (actor_role='business' AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=s0.business_id AND b.user_id=actor_id)) OR
      (actor_role='driver' AND EXISTS(SELECT 1 FROM drivers d WHERE d.id=s0.driver_id AND d.user_id=actor_id AND d.business_id=s0.business_id)));
  IF NOT FOUND THEN RETURN jsonb_build_object('error','NOT_FOUND','status',404); END IF;
  IF actor_role='driver' AND (command->>'action'<>'status' OR command->>'status' IN ('assigned','pending','cancelled')) THEN
    RETURN jsonb_build_object('error','FORBIDDEN','status',403);
  END IF;

  -- Conflicting inserts wait for the owner transaction. No externally held lease
  -- or partially committed command exists: rollback removes this reservation.
  INSERT INTO idempotency_requests(id,user_id,operation,key_hash,request_hash,resource_id,parameters)
    VALUES(request_id,actor_id,'shipments.update',key_digest,body_digest,s.id,command)
    ON CONFLICT(user_id,operation,key_hash) DO NOTHING;
  SELECT * INTO STRICT r FROM idempotency_requests WHERE user_id=actor_id AND operation='shipments.update' AND key_hash=key_digest FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM users u WHERE u.id=actor_id AND u.is_active AND u.role::text=actor_role) THEN
    IF r.state='pending' THEN DELETE FROM idempotency_requests WHERE id=r.id; END IF;
    RETURN jsonb_build_object('error','NOT_FOUND','status',404);
  END IF;
  IF r.request_hash<>body_digest THEN RETURN jsonb_build_object('error','IDEMPOTENCY_KEY_CONFLICT','status',409); END IF;
  IF r.expires_at<=statement_timestamp() OR r.parameters IS NULL THEN
    RETURN jsonb_build_object('error','IDEMPOTENCY_EXPIRED','status',410);
  END IF;
  IF r.state='completed' THEN
    IF NOT EXISTS(SELECT 1 FROM shipments s0 WHERE s0.id=command->>'shipmentId' AND (
      (actor_role='business' AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=s0.business_id AND b.user_id=actor_id)) OR
      (actor_role='driver' AND EXISTS(SELECT 1 FROM drivers d WHERE d.id=s0.driver_id AND d.user_id=actor_id AND d.business_id=s0.business_id)))) THEN
      RETURN jsonb_build_object('error','NOT_FOUND','status',404);
    END IF;
    RETURN jsonb_build_object('response',r.response,'replayed',true);
  END IF;

  -- Lock the shipment after the request: distinct keys still serialize here.
  SELECT * INTO s FROM shipments WHERE id=s.id FOR UPDATE;
  IF NOT FOUND THEN
    DELETE FROM idempotency_requests WHERE id=r.id;
    RETURN jsonb_build_object('error','NOT_FOUND','status',404);
  END IF;
  -- Recheck membership after waiting for the shipment lock.
  IF NOT ((actor_role='business' AND EXISTS(SELECT 1 FROM businesses b WHERE b.id=s.business_id AND b.user_id=actor_id)) OR
    (actor_role='driver' AND EXISTS(SELECT 1 FROM drivers d WHERE d.id=s.driver_id AND d.user_id=actor_id AND d.business_id=s.business_id))) THEN
    DELETE FROM idempotency_requests WHERE id=r.id;
    RETURN jsonb_build_object('error','NOT_FOUND','status',404);
  END IF;
  IF s.version<>(command->>'expectedVersion')::integer THEN
    DELETE FROM idempotency_requests WHERE id=r.id;
    RETURN jsonb_build_object('error','SHIPMENT_VERSION_CONFLICT','status',409);
  END IF;
  target_status := CASE command->>'action' WHEN 'assign' THEN 'assigned' WHEN 'cancel' THEN 'cancelled' ELSE command->>'status' END;
  IF NOT (CASE s.status
    WHEN 'pending' THEN target_status IN ('assigned','cancelled')
    WHEN 'assigned' THEN target_status IN ('picked_up','failed','cancelled')
    WHEN 'picked_up' THEN target_status='in_transit'
    WHEN 'in_transit' THEN target_status='out_for_delivery'
    WHEN 'out_for_delivery' THEN target_status IN ('delivered','failed')
    WHEN 'failed' THEN target_status='pending'
    ELSE false END) OR (target_status='assigned' AND command->>'action'<>'assign') THEN
    DELETE FROM idempotency_requests WHERE id=r.id;
    RETURN jsonb_build_object('error','INVALID_TRANSITION','status',422);
  END IF;
  IF target_status='assigned' AND NOT EXISTS(SELECT 1 FROM drivers d JOIN users u ON u.id=d.user_id
    WHERE d.id=command->>'driverId' AND d.business_id=s.business_id AND u.is_active AND u.role='driver') THEN
    DELETE FROM idempotency_requests WHERE id=r.id;
    RETURN jsonb_build_object('error','DRIVER_UNAVAILABLE','status',409);
  END IF;
  UPDATE shipments SET status=target_status,
    driver_id=CASE WHEN target_status='assigned' THEN command->>'driverId' WHEN target_status='pending' THEN NULL ELSE driver_id END,
    actual_pickup=CASE WHEN target_status='picked_up' THEN statement_timestamp() WHEN target_status='pending' THEN NULL ELSE actual_pickup END,
    actual_delivery=CASE WHEN target_status='delivered' THEN statement_timestamp() WHEN target_status='pending' THEN NULL ELSE actual_delivery END,
    updated_at=statement_timestamp() WHERE id=s.id RETURNING * INTO s;
  message := CASE command->>'action' WHEN 'assign' THEN 'Driver assigned' WHEN 'cancel' THEN 'Shipment cancelled' ELSE coalesce(command->>'note','') END;
  INSERT INTO shipment_events(id,shipment_id,status,message) VALUES(history_id,s.id,s.status,message);
  UPDATE idempotency_requests SET response=to_jsonb(s),state='completed',lease_token=NULL,lease_until=NULL WHERE id=r.id;
  RETURN jsonb_build_object('response',to_jsonb(s),'replayed',false);
END $$;
