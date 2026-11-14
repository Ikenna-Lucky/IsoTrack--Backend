CREATE INDEX drivers_fleet_page_idx ON drivers(business_id,created_at DESC,id COLLATE "C" DESC);
CREATE INDEX notifications_user_page_idx ON notifications(user_id,created_at DESC,id COLLATE "C" DESC);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id,created_at,id COLLATE "C") WHERE NOT is_read;
