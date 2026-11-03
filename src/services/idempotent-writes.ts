import { nanoid } from "nanoid";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type Stripe from "stripe";
import {
  WriteError,
  requireIdempotencyKey,
  hashValue,
  requestFingerprint,
  type WriteActor,
  type WriteResult,
  type WriteStore,
} from "../lib/idempotency.ts";
import { parseStripeSession } from "../lib/stripe-payload.ts";
import type { ShipmentInput, CheckoutInput } from "../lib/write-inputs";
import {
  findRequestStatement,
  reserveRequestStatement,
  claimRequestStatement,
  releaseRequestStatement,
  businessForWriteStatement,
  writableShipmentStatement,
  createShipmentOnceStatement,
  prepareCheckoutStatement,
  finishCheckoutStatement,
  type WriteOperation,
} from "../db/queries/idempotency.ts";

interface Dependencies {
  store: WriteStore;
  frontendUrl: string;
  providerContext: string;
  liveMode: boolean;
  createCheckout:
    | ((
        params: Stripe.Checkout.SessionCreateParams,
        key: string,
      ) => Promise<Stripe.Checkout.Session>)
    | null;
}
const savedRequest = z.object({
  id: z.string(),
  requestHash: z.string(),
  parameters: z.record(z.unknown()).nullable(),
  resourceId: z.string(),
  response: z.record(z.unknown()).nullable(),
  state: z.enum(["pending", "completed"]),
  expired: z.boolean(),
  providerSafe: z.boolean(),
});
type SavedRequest = z.infer<typeof savedRequest>;
const conflict = () =>
  new WriteError(
    409,
    "IDEMPOTENCY_IN_PROGRESS",
    "This request is processing; retry with the same key and data",
  );

export function createIdempotentWrites(deps: Dependencies) {
  const { store } = deps;
  async function existing(
    actor: WriteActor,
    operation: WriteOperation,
    key: string,
    body: unknown,
  ) {
    const rows = await store.execute(
      findRequestStatement(
        actor.userId,
        operation,
        hashValue(requireIdempotencyKey(key)),
      ),
    );
    if (!rows[0]) return null;
    return check(savedRequest.parse(rows[0]), body);
  }
  function check(request: SavedRequest, body: unknown) {
    if (request.requestHash !== requestFingerprint(body))
      throw new WriteError(
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "This key was already used with different request data",
      );
    if (request.expired || !request.parameters)
      throw new WriteError(
        410,
        "IDEMPOTENCY_EXPIRED",
        "This key has expired and cannot be reused; reconcile the original operation",
      );
    return request;
  }
  async function reserve(
    actor: WriteActor,
    operation: WriteOperation,
    key: string,
    body: unknown,
    parameters: Record<string, unknown>,
  ) {
    const rows = await store.execute(
      reserveRequestStatement({
        id: nanoid(),
        userId: actor.userId,
        operation,
        keyHash: hashValue(key),
        requestHash: requestFingerprint(body),
        resourceId: nanoid(),
        parameters,
      }),
    );
    return check(savedRequest.parse(rows[0]), body);
  }
  async function authorizeShipment(id: string, actor: WriteActor) {
    const row = (await store.execute(writableShipmentStatement(id, actor)))[0];
    if (!row) throw new WriteError(404, "NOT_FOUND", "Shipment not found");
    return row;
  }
  async function claim(request: SavedRequest, actor: WriteActor) {
    const token = randomUUID();
    if (
      !(
        await store.execute(
          claimRequestStatement(request.id, actor.userId, token),
        )
      ).length
    )
      throw conflict();
    return token;
  }
  async function run<T>(
    request: SavedRequest,
    actor: WriteActor,
    token: string,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      await store.execute(
        releaseRequestStatement(request.id, actor.userId, token),
      );
      throw error;
    }
  }
  function shipmentResult(
    raw: Record<string, unknown>,
    replayed: boolean,
  ): WriteResult {
    const data = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    );
    return {
      status: 201,
      body: { success: true, data, message: "Shipment created" },
      replayed,
    };
  }
  return {
    async createShipment(
      body: ShipmentInput,
      key: string,
      actor: WriteActor,
    ): Promise<WriteResult> {
      if (actor.role !== "business")
        throw new WriteError(
          403,
          "FORBIDDEN",
          "Only businesses can create shipments",
        );
      let request = await existing(actor, "shipments.create", key, body);
      if (!request) {
        const business = (
          await store.execute(
            businessForWriteStatement(
              actor,
              body.customerId,
              body.customerEmail,
            ),
          )
        )[0];
        if (!business)
          throw new WriteError(404, "NOT_FOUND", "Business profile not found");
        if (body.customerId && !business.customerId)
          throw new WriteError(
            422,
            "INVALID_CUSTOMER",
            "Customer account is unavailable",
          );
        request = await reserve(actor, "shipments.create", key, body, {
          ...body,
          ...business,
          trackingId: `IST-${nanoid(16).toUpperCase()}`,
          eventId: nanoid(),
        });
      }
      if (request.response) {
        await authorizeShipment(request.resourceId, actor);
        return shipmentResult(request.response, true);
      }
      const token = await claim(request, actor);
      return run(request, actor, token, async () => {
        const row = (
          await store.execute(
            createShipmentOnceStatement(request.id, actor, token),
          )
        )[0];
        if (!row?.response)
          throw new WriteError(
            409,
            "WRITE_CONFLICT",
            "Shipment could not be created with the original account details",
          );
        return shipmentResult(row.response as Record<string, unknown>, false);
      });
    },
    async initializeCheckout(
      body: CheckoutInput,
      key: string,
      actor: WriteActor,
    ): Promise<WriteResult> {
      if (!["business", "customer"].includes(actor.role))
        throw new WriteError(403, "FORBIDDEN", "Payment access denied");
      let request = await existing(actor, "payments.initialize", key, body);
      const shipment = await authorizeShipment(body.shipmentId, actor);
      if (!request) {
        if (!deps.createCheckout)
          throw new WriteError(
            503,
            "PAYMENTS_UNAVAILABLE",
            "Payments unavailable",
          );
        if (!shipment.payable)
          throw new WriteError(409, "NOT_PAYABLE", "Shipment is not payable");
        const reference = `IST-PAY-${nanoid(24)}`;
        const returnUrl = new URL("/customer/shipments", deps.frontendUrl);
        returnUrl.searchParams.set("payment_reference", reference);
        const params: Stripe.Checkout.SessionCreateParams = {
          mode: "payment",
          ui_mode: "hosted_page",
          allowed_payment_method_types: ["card"],
          customer_email: actor.email,
          client_reference_id: reference,
          metadata: { reference, shipmentId: body.shipmentId },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "ngn",
                unit_amount: Number(shipment.priceKobo),
                product_data: {
                  name: `Shipment ${String(shipment.trackingId)}`,
                },
              },
            },
          ],
          success_url: returnUrl.toString(),
          cancel_url: new URL(
            "/customer/shipments?payment_cancelled=1",
            deps.frontendUrl,
          ).toString(),
        };
        request = await reserve(actor, "payments.initialize", key, body, {
          shipmentId: body.shipmentId,
          reference,
          amountKobo: shipment.priceKobo,
          providerContext: deps.providerContext,
          params,
        });
      }
      const parameters = request.parameters!;
      if (parameters.providerContext !== deps.providerContext)
        throw new WriteError(
          409,
          "RECONCILIATION_REQUIRED",
          "Payment configuration changed; reconcile the original attempt",
        );
      if (request.response)
        return { status: 200, body: request.response, replayed: true };
      if (!request.providerSafe)
        throw new WriteError(
          409,
          "RECONCILIATION_REQUIRED",
          "Provider retry window ended; reconcile the original payment attempt",
          { reference: String(parameters.reference) },
        );
      if (!deps.createCheckout)
        throw new WriteError(
          503,
          "PAYMENTS_UNAVAILABLE",
          "Payments unavailable",
        );
      const token = await claim(request, actor);
      return run(request, actor, token, async () => {
        if (
          !(
            await store.execute(
              prepareCheckoutStatement(request.id, actor, token),
            )
          ).length
        )
          throw new WriteError(
            409,
            "NOT_PAYABLE",
            "The original payment attempt is no longer payable",
            { reference: String(parameters.reference) },
          );
        let session: Stripe.Checkout.Session;
        try {
          session = await deps.createCheckout!(
            parameters.params as Stripe.Checkout.SessionCreateParams,
            `isotrack_${request.id}`,
          );
        } catch {
          throw new WriteError(
            502,
            "PAYMENT_PROVIDER_UNAVAILABLE",
            "Retry with the same key and data; the provider outcome may be unknown",
            { reference: String(parameters.reference) },
          );
        }
        const parsed = parseStripeSession(
          session,
          String(parameters.reference),
        );
        let validUrl = false;
        try {
          const url = new URL(session.url!);
          validUrl =
            url.protocol === "https:" && url.hostname === "checkout.stripe.com";
        } catch {
          /* Invalid provider URL. */
        }
        if (
          !parsed ||
          !validUrl ||
          session.amount_total !== parameters.amountKobo ||
          session.currency !== "ngn" ||
          session.metadata?.shipmentId !== parameters.shipmentId ||
          session.livemode !== deps.liveMode
        ) {
          throw new WriteError(
            502,
            "INVALID_CHECKOUT_RESPONSE",
            "Provider returned inconsistent checkout details; preserve the original key",
            { reference: String(parameters.reference) },
          );
        }
        const response = {
          success: true,
          data: {
            reference: parameters.reference,
            authorizationUrl: session.url,
            sessionId: session.id,
            amountKobo: parameters.amountKobo,
          },
        };
        const row = (
          await store.execute(
            finishCheckoutStatement(
              request.id,
              actor.userId,
              token,
              session.id,
              response,
            ),
          )
        )[0];
        if (!row?.response) throw conflict();
        return {
          status: 200,
          body: row.response as Record<string, unknown>,
          replayed: false,
        };
      });
    },
  };
}
