import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { emailRetrySeconds } from "../lib/email-retry.ts";
import type { WriteStore } from "../lib/idempotency.ts";
import { deliveryCode, deliveryProof } from "../lib/delivery-code.ts";
import type { AccountEmail } from "./account-email.ts";
const context = z.object({
  id: z.string(),
  email: z.string().email(),
  codeHash: z.string(),
  trackingId: z.string(),
});
function finish(
  id: string,
  lease: string,
  state: "sent" | "skipped" | "failed",
  retrySeconds = 0,
) {
  return sql`update delivery_confirmations set delivery_state=case when ${state}='failed' then case when attempts>=5 then 'dead' else 'pending' end else ${state} end,
  available_at=statement_timestamp()+greatest(least(300,power(2,attempts)::int*5),${retrySeconds}::int)*interval '1 second',lease_token=null,lease_until=null
  where id=${id} and delivery_state='processing' and lease_token=${lease} and lease_until>statement_timestamp() returning json_build_object('done',true) as result`;
}
export function createDeliveryEmailProcessor(
  store: WriteStore,
  secret: string,
  send: (email: AccountEmail) => Promise<void>,
) {
  return async () => {
    const lease = randomUUID();
    const rows = await store.execute(sql`with exhausted as (
   update delivery_confirmations set delivery_state='dead',lease_token=null,lease_until=null where id in
    (select id from delivery_confirmations where delivery_state='processing' and lease_until<=statement_timestamp() and attempts>=5 order by lease_until limit 100 for update skip locked) returning id
   ), due as (select id from delivery_confirmations where attempts<5 and
    ((delivery_state='pending' and available_at<=statement_timestamp()) or (delivery_state='processing' and lease_until<=statement_timestamp()))
    order by available_at limit 5 for update skip locked)
   update delivery_confirmations d set delivery_state='processing',attempts=attempts+1,lease_token=${lease},lease_until=statement_timestamp()+interval '2 minutes'
   from due where d.id=due.id returning json_build_object('id',d.id) as result`);
    await Promise.all(
      rows.map(async (row) => {
        const id = String(row.id);
        try {
          const value = (
            await store.execute(sql`select json_build_object('id',d.id,'email',d.email,'codeHash',d.code_hash,'trackingId',s.tracking_id) as result
     from delivery_confirmations d join shipments s on s.id=d.shipment_id join drivers dr on dr.id=s.driver_id and dr.business_id=s.business_id
     join users u on u.id=dr.user_id and u.is_active and u.role='driver'
     where d.id=${id} and d.lease_token=${lease} and d.delivery_state='processing' and d.lease_until>statement_timestamp()
     and d.revoked_at is null and d.consumed_at is null and d.failures<5 and d.expires_at>statement_timestamp()
     and s.status='out_for_delivery' and s.version=d.shipment_version and s.driver_id=d.driver_id and s.recipient_email=d.email`)
          )[0];
          if (!value) {
            await store.execute(finish(id, lease, "skipped"));
            return;
          }
          const data = context.parse(value),
            code = deliveryCode(id, secret);
          if (deliveryProof(id, code, secret) !== data.codeHash) {
            await store.execute(finish(id, lease, "skipped"));
            return;
          }
          await send({
            to: data.email,
            subject: "Your IsoTrack delivery confirmation code",
            messageId: `<delivery-${id}@isotrack.invalid>`,
            text: `Your code for shipment ${data.trackingId} is ${code}. It expires 20 minutes after it was requested. Share it with the assigned driver only after receiving your package. If you are not expecting this delivery, do not share the code.`,
          });
          if (!(await store.execute(finish(id, lease, "sent"))).length)
            throw new Error("Delivery email lease lost");
        } catch (cause) {
          await store.execute(
            finish(id, lease, "failed", emailRetrySeconds(cause)),
          );
        }
      }),
    );
  };
}
