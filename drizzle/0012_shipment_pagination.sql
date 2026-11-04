CREATE INDEX shipments_business_page_idx ON shipments (business_id, created_at DESC, id COLLATE "C" DESC);

CREATE INDEX shipments_customer_page_idx ON shipments (customer_id, created_at DESC, id COLLATE "C" DESC);

CREATE INDEX shipments_driver_page_idx ON shipments (
  driver_id,
  business_id,
  created_at DESC,
  id COLLATE "C" DESC
);

CREATE INDEX shipments_driver_active_page_idx ON shipments (
  driver_id,
  business_id,
  created_at DESC,
  id COLLATE "C" DESC
)
WHERE
  status NOT IN ('delivered', 'failed', 'cancelled');

CREATE INDEX shipment_events_page_idx ON shipment_events (shipment_id, created_at DESC, id COLLATE "C" DESC);