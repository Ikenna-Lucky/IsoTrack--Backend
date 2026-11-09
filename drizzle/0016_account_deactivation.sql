-- Row locks serialize account closure with new work. No historical data is deleted.
CREATE FUNCTION lock_active_accounts(account_ids text[]) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM id FROM users WHERE id=ANY(account_ids) ORDER BY id FOR SHARE;
  RETURN NOT EXISTS (SELECT 1 FROM users WHERE id=ANY(account_ids) AND NOT is_active);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION guard_active_shipment_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; driver_user_id text;
BEGIN
  IF NEW.status IN ('delivered','cancelled') OR
    (NEW.status='failed' AND (NEW.actual_pickup IS NULL OR NEW.return_state='received')) THEN
    RETURN NEW;
  END IF;
  SELECT user_id INTO owner_id FROM businesses WHERE id=NEW.business_id;
  SELECT user_id INTO driver_user_id FROM drivers WHERE id=NEW.driver_id;
  IF NOT lock_active_accounts(ARRAY[owner_id,driver_user_id,NEW.customer_id]) THEN
    RAISE EXCEPTION 'Inactive shipment participant' USING ERRCODE='23514',CONSTRAINT='active_shipment_accounts';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shipments_active_accounts BEFORE INSERT OR UPDATE OF business_id,driver_id,customer_id,status
ON shipments FOR EACH ROW EXECUTE FUNCTION guard_active_shipment_accounts();
--> statement-breakpoint
CREATE FUNCTION guard_active_fleet_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.business_id IS NOT DISTINCT FROM OLD.business_id
    AND NEW.status='offline' THEN RETURN NEW; END IF;
  SELECT user_id INTO owner_id FROM businesses WHERE id=NEW.business_id;
  IF NOT lock_active_accounts(ARRAY[owner_id,NEW.user_id]) THEN
    RAISE EXCEPTION 'Inactive fleet participant' USING ERRCODE='23514',CONSTRAINT='active_fleet_accounts';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER drivers_active_accounts BEFORE INSERT OR UPDATE OF business_id,user_id,status
ON drivers FOR EACH ROW EXECUTE FUNCTION guard_active_fleet_accounts();
--> statement-breakpoint
CREATE FUNCTION guard_active_invitation_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
  SELECT user_id INTO owner_id FROM businesses WHERE id=NEW.business_id;
  IF NOT lock_active_accounts(ARRAY[owner_id]) THEN
    RAISE EXCEPTION 'Inactive invitation owner' USING ERRCODE='23514',CONSTRAINT='active_invitation_owner';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER invitations_active_owner BEFORE INSERT ON driver_invitations
FOR EACH ROW EXECUTE FUNCTION guard_active_invitation_owner();
--> statement-breakpoint
ALTER FUNCTION prepare_payment_checkout(text,text,text,text) RENAME TO prepare_payment_checkout_before_deactivation;
--> statement-breakpoint
CREATE FUNCTION prepare_payment_checkout(request_id text,actor_id text,actor_role text,token text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE owner_id text; customer_id text;
BEGIN
  SELECT b.user_id,s.customer_id INTO owner_id,customer_id
  FROM idempotency_requests r JOIN shipments s ON s.id=r.parameters->>'shipmentId'
  JOIN businesses b ON b.id=s.business_id WHERE r.id=request_id AND r.user_id=actor_id;
  IF NOT lock_active_accounts(ARRAY[actor_id,owner_id,customer_id]) THEN RETURN NULL; END IF;
  RETURN prepare_payment_checkout_before_deactivation(request_id,actor_id,actor_role,token);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION deactivate_account(account_id text,expected_password_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE actor users%ROWTYPE;
BEGIN
  -- Driver status/membership writes lock the profile before its account row.
  PERFORM id FROM drivers WHERE user_id=account_id FOR UPDATE;
  -- A separate statement after this lock sees work committed by admitted writers.
  SELECT * INTO actor FROM users WHERE id=account_id FOR UPDATE;
  IF NOT FOUND OR NOT actor.is_active THEN RETURN jsonb_build_object('error','ACCOUNT_INACTIVE'); END IF;
  IF actor.password_hash IS DISTINCT FROM expected_password_hash THEN RETURN jsonb_build_object('error','CREDENTIALS_CHANGED'); END IF;
  IF actor.role='business' AND EXISTS(
    SELECT 1 FROM drivers d JOIN businesses b ON b.id=d.business_id WHERE b.user_id=account_id
  ) THEN RETURN jsonb_build_object('error','FLEET_OFFBOARDING_REQUIRED'); END IF;
  IF EXISTS(
    SELECT 1 FROM shipments s LEFT JOIN businesses b ON b.id=s.business_id
    LEFT JOIN drivers d ON d.id=s.driver_id
    WHERE (b.user_id=account_id OR d.user_id=account_id OR s.customer_id=account_id)
    AND (s.status NOT IN ('delivered','cancelled','failed') OR
      (s.status='failed' AND s.actual_pickup IS NOT NULL AND s.return_state<>'received'))
  ) THEN RETURN jsonb_build_object('error','ACTIVE_SHIPMENTS'); END IF;
  IF EXISTS(
    SELECT 1 FROM payments p JOIN shipments s ON s.id=p.shipment_id
    LEFT JOIN businesses b ON b.id=s.business_id LEFT JOIN drivers d ON d.id=s.driver_id
    WHERE (b.user_id=account_id OR d.user_id=account_id OR s.customer_id=account_id)
    AND ((p.status='pending' AND p.checkout_state IN ('creating','open','review')) OR
      (p.received_at IS NOT NULL AND p.review_reason IS NOT NULL AND p.status<>'refunded') OR
      EXISTS(SELECT 1 FROM payment_checkout_guards g WHERE g.payment_id=p.id))
  ) THEN RETURN jsonb_build_object('error','UNRESOLVED_PAYMENTS'); END IF;
  UPDATE users SET is_active=false,updated_at=statement_timestamp() WHERE id=account_id;
  -- Existing credential-version trigger invalidates all sessions/actions in O(1).
  UPDATE drivers SET status='offline',current_location=NULL,updated_at=statement_timestamp()
    WHERE user_id=account_id;
  RETURN jsonb_build_object('deactivated',true);
END;
$$;
