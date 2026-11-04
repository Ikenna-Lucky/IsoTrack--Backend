CREATE INDEX account_actions_dead_idx ON account_actions (available_at)
WHERE
    delivery_state = 'dead';

--> statement-breakpoint
CREATE INDEX payments_unresolved_review_idx ON payments (received_at)
WHERE
    review_reason IS NOT NULL
    AND refund_id IS NULL;