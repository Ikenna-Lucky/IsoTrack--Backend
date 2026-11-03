CREATE TABLE idempotency_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('shipments.create','payments.initialize')),
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  parameters jsonb,
  resource_id text NOT NULL,
  response jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed')),
  lease_token text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  scrubbed_at timestamptz,
  CONSTRAINT idempotency_requests_scope UNIQUE(user_id,operation,key_hash),
  CONSTRAINT idempotency_requests_hashes CHECK(length(key_hash)=64 AND length(request_hash)=64),
  CONSTRAINT idempotency_requests_lease CHECK (
    (lease_token IS NULL AND lease_until IS NULL) OR
    (state='pending' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT idempotency_requests_response CHECK (
    (state='completed' AND (response IS NOT NULL OR scrubbed_at IS NOT NULL)) OR
    (state='pending' AND response IS NULL)),
  CONSTRAINT idempotency_requests_expiry CHECK(expires_at>created_at)
);
--> statement-breakpoint
CREATE INDEX idempotency_requests_cleanup_idx ON idempotency_requests(created_at) WHERE scrubbed_at IS NULL;
