-- Capture candidates atomically with the event; the worker checks current choices.
CREATE FUNCTION capture_driver_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shipment shipments%ROWTYPE;
  recipient text;
  body jsonb;
  event_status text;
BEGIN
  IF TG_TABLE_NAME='shipment_exceptions' THEN
    IF NEW.action<>'fail' THEN RETURN NEW; END IF;
    event_status := 'failed';
  ELSE
    IF NEW.status::text NOT IN ('assigned','delivered') THEN RETURN NEW; END IF;
    event_status := NEW.status::text;
  END IF;
  SELECT * INTO STRICT shipment FROM shipments WHERE id=NEW.shipment_id;
  SELECT d.user_id INTO recipient FROM drivers d JOIN users u ON u.id=d.user_id
    WHERE d.id=shipment.driver_id AND d.business_id=shipment.business_id AND u.role='driver' AND u.is_active;
  IF recipient IS NULL THEN RETURN NEW; END IF;
  body := jsonb_build_object('trackingId',shipment.tracking_id,'status',event_status,
    'businessId',shipment.business_id,'driverId',shipment.driver_id,'driverUserId',recipient,'amountKobo',shipment.price_kobo);
  INSERT INTO notification_outbox(id,shipment_id,recipient_id,channel,kind,payload) VALUES
    ('shipment_'||NEW.id||'_driver_in_app',shipment.id,recipient,'in_app','shipment_status',body),
    ('shipment_'||NEW.id||'_driver_email',shipment.id,recipient,'email','shipment_status',body)
    ON CONFLICT(id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER driver_shipment_event_outbox AFTER INSERT ON shipment_events
FOR EACH ROW EXECUTE FUNCTION capture_driver_notification_event();
--> statement-breakpoint
CREATE TRIGGER driver_exception_outbox AFTER INSERT ON shipment_exceptions
FOR EACH ROW EXECUTE FUNCTION capture_driver_notification_event();
