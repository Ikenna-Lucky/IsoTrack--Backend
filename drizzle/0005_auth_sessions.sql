ALTER TABLE users ADD COLUMN credential_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE FUNCTION invalidate_user_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    NEW.credential_version := OLD.credential_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_invalidate_credentials BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION invalidate_user_credentials();
--> statement-breakpoint
CREATE TABLE auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_version integer NOT NULL,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiry CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
--> statement-breakpoint
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
