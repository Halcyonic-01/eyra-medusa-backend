import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { postToStorefront } from "../../../../../utils/storefront"
import { grantDispatchOverrideWorkflow, revokeDispatchOverrideWorkflow } from "../../../../../workflows/dispatch-override"
import type { DispatchOverrideBody } from "../../../razorpay-confirmations/validation"

/** Only a signed-in staff member, never an API key, may release an order by hand. */
function staffMember(req: AuthenticatedMedusaRequest): string {
  const context = req.auth_context
  if (context?.actor_type !== "user" || !context.actor_id) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Only a signed-in staff member can do this")
  }
  return context.actor_id
}

/**
 * POST /admin/orders/:id/dispatch-override   { reason }
 *
 * Lets an order made in Medusa admin (no checkout behind it) be shipped once
 * its payment is recorded. Who, when and why are kept, and the team is told.
 */
export async function POST(req: AuthenticatedMedusaRequest<DispatchOverrideBody>, res: MedusaResponse) {
  const actorId = staffMember(req)
  const { result } = await grantDispatchOverrideWorkflow(req.scope).run({
    input: { order_id: req.params.id, actor_id: actorId, reason: req.validatedBody.reason },
  })
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  logger.warn(`[dispatch] override for order ${req.params.id} by ${actorId}: ${req.validatedBody.reason}`)
  await postToStorefront(
    "/api/ops/notify",
    { type: "dispatch_override", order_id: req.params.id, actor_id: actorId, reason: req.validatedBody.reason },
    logger
  )
  return res.json({ override: result })
}

/** DELETE /admin/orders/:id/dispatch-override: withdraws it (the record is kept). */
export async function DELETE(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const actorId = staffMember(req)
  const { result } = await revokeDispatchOverrideWorkflow(req.scope).run({ input: { order_id: req.params.id, actor_id: actorId } })
  req.scope.resolve(ContainerRegistrationKeys.LOGGER).warn(`[dispatch] override for order ${req.params.id} withdrawn by ${actorId}`)
  return res.json({ override: result })
}
