import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { grantDispatchOverrideStep, revokeDispatchOverrideStep, type GrantOverrideInput } from "./steps/dispatch-override"

/** Staff allow an admin-made order (no checkout) to ship. Audited; payment still required. */
export const grantDispatchOverrideWorkflow = createWorkflow(
  "grant-dispatch-override",
  function (input: GrantOverrideInput) {
    return new WorkflowResponse(grantDispatchOverrideStep(input))
  }
)

/** Staff withdraw such an override. */
export const revokeDispatchOverrideWorkflow = createWorkflow(
  "revoke-dispatch-override",
  function (input: { order_id: string; actor_id: string }) {
    return new WorkflowResponse(revokeDispatchOverrideStep(input))
  }
)
