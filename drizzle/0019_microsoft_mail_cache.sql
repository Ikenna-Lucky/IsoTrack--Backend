CREATE TABLE microsoft_mail_cache (
  id text PRIMARY KEY,
  encrypted_cache text,
  lease_id uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

