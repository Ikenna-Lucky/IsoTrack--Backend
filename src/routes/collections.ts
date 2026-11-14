import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { parseCollectionPage, shipmentCursor } from "../lib/shipment-page.ts";
import { WriteError, type WriteStore } from "../lib/idempotency.ts";

const rowsSchema = z.array(
  z.object({
    payload: z.object({ id: z.string() }).passthrough(),
    time: z.string(),
  }),
);
export function createCollectionRouter(
  store: WriteStore,
  collection: "drivers" | "available-drivers" | "notifications",
) {
  const router = new Hono();
  router.get(
    collection === "available-drivers" ? "/available" : "/",
    async (c) => {
      c.header("Cache-Control", "no-store");
      const actor = { userId: c.get("userId"), role: c.get("userRole") };
      if (collection !== "notifications" && actor.role !== "business")
        return c.json({ success: false, error: "FORBIDDEN" }, 403);
      try {
        const page = parseCollectionPage(
          new URL(c.req.url).searchParams,
          actor,
          collection,
        );
        const time = page.position?.time ?? null,
          id = page.position?.id ?? null;
        const query =
          collection === "notifications"
            ? sql`
     select jsonb_build_object('payload',jsonb_build_object('id',n.id,'userId',n.user_id,'type',n.type,'title',n.title,'message',n.message,'isRead',n.is_read,'status',n.status,'metadata',n.metadata,'createdAt',n.created_at),
       'time',to_char(n.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as result
     from notifications n where n.user_id=${actor.userId}
       and (${time}::timestamptz is null or (n.created_at,n.id collate "C")<(${time}::timestamptz,${id}::text collate "C"))
     order by n.created_at desc,n.id collate "C" desc limit ${page.limit + 1}`
            : sql`
     select jsonb_build_object('payload',jsonb_build_object('id',d.id,'businessId',d.business_id,'userId',d.user_id,'vehicleType',d.vehicle_type,'vehiclePlate',d.vehicle_plate,
       'vehicleModel',d.vehicle_model,'vehicleColor',d.vehicle_color,'vehicleYear',d.vehicle_year,'vehicleInsurance',d.vehicle_insurance,
       'status',d.status,'currentLocation',d.current_location,'rating',d.rating,'totalDeliveries',d.total_deliveries,'createdAt',d.created_at,'updatedAt',d.updated_at,
       'user',jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'phone',u.phone,'avatar',u.avatar,'isActive',u.is_active)),
       'time',to_char(d.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as result
     from drivers d join businesses b on b.id=d.business_id join users u on u.id=d.user_id
     where b.user_id=${actor.userId} and (${collection === "available-drivers"}=false or (d.status='available' and u.is_active))
       and (${time}::timestamptz is null or (d.created_at,d.id collate "C")<(${time}::timestamptz,${id}::text collate "C"))
     order by d.created_at desc,d.id collate "C" desc limit ${page.limit + 1}`;
        const rows = rowsSchema.parse(await store.execute(query)),
          visible = rows.slice(0, page.limit),
          last = visible.at(-1),
          hasMore = rows.length > page.limit;
        return c.json({
          success: true,
          data: visible.map((r) => r.payload),
          pagination: {
            limit: page.limit,
            hasMore,
            nextCursor:
              hasMore && last
                ? shipmentCursor(page.scope, last.time, last.payload.id)
                : null,
          },
        });
      } catch (error) {
        if (error instanceof WriteError)
          return c.json(
            { success: false, error: error.code, message: error.message },
            error.status,
          );
        throw error;
      }
    },
  );
  return router;
}

export function createNotificationMutationRouter(store: WriteStore) {
  const router = new Hono();
  router.patch("/read-all", async (c) => {
    const user = c.get("userId");
    const [row] = await store.execute(sql`with batch as materialized(
    select id from notifications where user_id=${user} and not is_read order by created_at,id collate "C" limit 500 for update skip locked
   ), changed as(update notifications n set is_read=true from batch b where n.id=b.id and n.user_id=${user} returning n.id)
   select jsonb_build_object('updated',(select count(*)::integer from changed),'hasMore',exists(select 1 from notifications n where n.user_id=${user} and not n.is_read and not exists(select 1 from changed x where x.id=n.id))) as result`);
    return c.json({ success: true, data: row });
  });
  router.patch("/:id/read", async (c) => {
    const [row] =
      await store.execute(sql`update notifications set is_read=true where id=${c.req.param("id")} and user_id=${c.get("userId")}
    returning jsonb_build_object('id',id,'isRead',is_read) as result`);
    if (!row)
      return c.json(
        {
          success: false,
          error: "NOT_FOUND",
          message: "Notification not found",
        },
        404,
      );
    return c.json({ success: true, data: row });
  });
  router.delete("/:id", async (c) => {
    const rows = await store.execute(
      sql`delete from notifications where id=${c.req.param("id")} and user_id=${c.get("userId")} returning jsonb_build_object('deleted',true) as result`,
    );
    if (!rows.length)
      return c.json(
        {
          success: false,
          error: "NOT_FOUND",
          message: "Notification not found",
        },
        404,
      );
    return c.json({
      success: true,
      data: null,
      message: "Notification deleted",
    });
  });
  return router;
}
