import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { ShipmentDetails } from "../../modules/order-dispatch/transitions"
import { callStorefront } from "../../utils/storefront"
import type { ShipmentPlan } from "./build-shipment-request"

export type ShipmentOutcome =
  | { ok: true; shipment: ShipmentDetails }
  | { ok: false; error: string; canceled?: boolean }

type Input = {
  plan: ShipmentPlan
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : value == null ? null : String(value)

/** What the storefront's shipping route said, as a result the dispatcher can act on. */
function interpretReply(plan: Extract<ShipmentPlan, { action: "ship" }>, reply: Awaited<ReturnType<typeof callStorefront>>): ShipmentOutcome {
  if (reply.kind !== "answered") {
    return { ok: false, error: reply.message }
  }

  const body = reply.body ?? {}
  if (reply.status < 200 || reply.status >= 300) {
    return {
      ok: false,
      error: `The storefront answered ${reply.status}${body.error ? `: ${String(body.error)}` : ""}`,
    }
  }

  const shipmentId = str(body.shipmentId)
  if (body.success !== true || !shipmentId) {
    return { ok: false, error: str(body.error) ?? "The courier did not create a shipment" }
  }

  const awbCode = str(body.awbCode)
  const labelUrl = str(body.labelUrl)
  const pickupScheduled = typeof body.pickupScheduled === "boolean" ? body.pickupScheduled : null

  // The shipment exists, but say so plainly if part of it is missing.
  const notes: string[] = []
  if (!awbCode) {
    notes.push("no courier or AWB was assigned")
  } else if (!labelUrl) {
    notes.push("the label was not created")
  }
  if (pickupScheduled === false) {
    notes.push("the pickup was not scheduled")
  }
  const warning = str(body.warning)
  if (warning) {
    notes.push(warning)
  }

  return {
    ok: true,
    shipment: {
      shiprocket_order_ref: plan.request.eyraOrderRef,
      shiprocket_order_id: str(body.shiprocketOrderId),
      shiprocket_shipment_id: shipmentId,
      awb_code: awbCode,
      courier_name: str(body.courierName),
      label_url: labelUrl,
      pickup_scheduled: pickupScheduled,
      note: notes.length > 0 ? `Shipment created, but ${notes.join("; ")}` : null,
    },
  }
}

/**
 * Creates the shipment: the courier order, the AWB, the label and the pickup.
 * That work lives in the storefront's shipping route (it already talks to
 * Shiprocket); this asks it to run and reports what happened. Never throws, so
 * the dispatch is always recorded as shipped or failed.
 */
export const requestShipmentStep = createStep(
  "request-shipment",
  async (input: Input): Promise<StepResponse<ShipmentOutcome>> => {
    const { plan } = input

    if (plan.action === "adopt") {
      return new StepResponse<ShipmentOutcome>({ ok: true, shipment: plan.shipment })
    }

    if (plan.action === "stop") {
      return new StepResponse<ShipmentOutcome>({
        ok: false,
        error: plan.detail,
        canceled: plan.reason === "order_canceled",
      })
    }

    // Longer than the route's own limit (maxDuration 120 s there), so a retry
    // never starts while the first attempt could still be running.
    const reply = await callStorefront(
      "/api/shipping/create-shipment",
      plan.request as unknown as Record<string, unknown>,
      { timeoutMs: 150000 }
    )
    return new StepResponse<ShipmentOutcome>(interpretReply(plan, reply))
  }
)
