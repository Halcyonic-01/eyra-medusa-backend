import {
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { useQueryGraphStep } from "@medusajs/medusa/core-flows"
import { buildShipmentRequestStep } from "./steps/build-shipment-request"
import { claimDispatchStep } from "./steps/claim-dispatch"
import { finishDispatchStep } from "./steps/finish-dispatch"
import { mirrorDispatchToOrderStep } from "./steps/mirror-dispatch-to-order"
import { requestShipmentStep } from "./steps/request-shipment"

export type DispatchOrderInput = {
  order_id: string
  /** Skip the cancel window and any retry delay ("Ship now"). */
  force?: boolean
}

/**
 * Creates the courier shipment for one order, once. The order is claimed
 * atomically first, so a customer cancelling and the dispatcher shipping can
 * never both succeed, and two dispatchers can never ship the same order twice.
 * The result says what state the order ended in.
 */
export const dispatchOrderWorkflow = createWorkflow(
  "dispatch-order",
  function (input: DispatchOrderInput) {
    const claim = claimDispatchStep({ order_id: input.order_id, force: input.force })

    const finished = when("order-claimed", claim, (data) => data.claimed).then(() => {
      const { data: orders } = useQueryGraphStep({
        entity: "order",
        fields: [
          "id",
          "display_id",
          "email",
          "status",
          "canceled_at",
          "total",
          "metadata",
          "items.title",
          "items.product_title",
          "items.variant_sku",
          "items.product_type",
          "items.unit_price",
          "items.quantity",
          "items.detail.quantity",
          "shipping_address.*",
          "credit_lines.amount",
          "payment_collections.payments.provider_id",
        ],
        filters: { id: input.order_id },
      })

      const plan = buildShipmentRequestStep({ orders })
      const outcome = requestShipmentStep({ plan })

      const finish = finishDispatchStep(
        transform({ input, claim, plan, outcome }, (data) => ({
          order_id: data.input.order_id,
          attempts: data.claim.dispatch?.attempts ?? 1,
          plan: data.plan,
          outcome: data.outcome,
        }))
      )

      mirrorDispatchToOrderStep(
        transform({ input, finish }, (data) => ({
          order_id: data.input.order_id,
          finish: data.finish,
        }))
      )

      return finish
    })

    const result = transform({ claim, finished }, (data) => ({
      claimed: data.claim.claimed,
      reason: data.claim.reason,
      state: data.finished?.state ?? data.claim.dispatch?.state ?? null,
      error: data.finished?.error ?? null,
      dispatch: data.finished?.dispatch ?? data.claim.dispatch,
    }))

    return new WorkflowResponse(result)
  }
)
