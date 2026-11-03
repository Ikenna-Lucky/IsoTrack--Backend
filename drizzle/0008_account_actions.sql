CREATE TABLE account_actions (
  id text PRIMARY KEY,
  user_id text NOT NULL CONSTRAINT account_actions_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('reset_password', 'verify_email', 'password_changed')),
  email text NOT NULL,
  credential_version integer NOT NULL,
  token_hash text,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivery_state text NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending','processing','sent','skipped','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  CONSTRAINT account_action_expiry CHECK (expires_at > created_at),
  CONSTRAINT account_action_token CHECK ((purpose = 'password_changed' AND token_hash IS NULL) OR (purpose <> 'password_changed' AND token_hash IS NOT NULL AND length(token_hash) = 64)),
  CONSTRAINT account_action_lease CHECK ((delivery_state = 'processing' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (delivery_state <> 'processing' AND lease_token IS NULL AND lease_until IS NULL))
);
--> statement-breakpoint
CREATE INDEX account_actions_user_idx ON account_actions(user_id);
--> statement-breakpoint
CREATE INDEX account_actions_due_idx ON account_actions(available_at) WHERE delivery_state = 'pending';
--> statement-breakpoint
CREATE INDEX account_actions_lease_idx ON account_actions(lease_until) WHERE delivery_state = 'processing';
--> statement-breakpoint
CREATE INDEX account_actions_expiry_idx ON account_actions(expires_at);
--> statement-breakpoint
CREATE TABLE account_action_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  next_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX account_action_limits_cleanup_idx ON account_action_limits(window_start);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_user_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.is_active IS DISTINCT FROM OLD.is_active OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.credential_version := OLD.credential_version + 1;
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.is_email_verified := false;
  END IF;
  RETURN NEW;
END;
$$;
