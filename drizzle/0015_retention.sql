CREATE TABLE
    retention_runs (
        task text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now (),
        last_success_at timestamptz,
        last_affected integer NOT NULL DEFAULT 0 CHECK (last_affected BETWEEN 0 AND 500)
    );

INSERT INTO
    retention_runs (task)
VALUES
    ('sessions'),
    ('idempotency'),
    ('outbox'),
    ('account_actions'),
    ('account_limits'),
    ('delivery_expired'),
    ('delivery_consumed');

INSERT INTO
    retention_runs (task)
VALUES
    ('invitations'),
    ('notifications'),
    ('shipment_gps'),
    ('event_gps');

CREATE INDEX delivery_confirmations_expired_cleanup_idx ON delivery_confirmations (expires_at, id)
WHERE
    consumed_at IS NULL
    AND delivery_state <> 'processing';

CREATE INDEX delivery_confirmations_consumed_cleanup_idx ON delivery_confirmations (consumed_at, id)
WHERE
    consumed_at IS NOT NULL
    AND delivery_state <> 'processing';

CREATE INDEX driver_invitations_cleanup_idx ON driver_invitations (expires_at, id)
WHERE
    accepted_at IS NULL;

CREATE INDEX notifications_cleanup_idx ON notifications (created_at, id)
WHERE
    is_read
    AND status = 'sent';

CREATE INDEX shipments_gps_cleanup_idx ON shipments (
    (
        case
            when status = 'delivered' then actual_delivery
            when status = 'cancelled' then updated_at
            when status = 'failed'
            and return_state = 'received' then returned_at
        end
    ),
    id
)
WHERE
    current_location IS NOT NULL;

CREATE INDEX shipment_events_gps_cleanup_idx ON shipment_events (created_at, id)
WHERE
    location IS NOT NULL;