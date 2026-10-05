import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { getPendingReturnRequestStep } from "./steps/get-pending-return-request"
import { resolveReturnRequestStep } from "./steps/resolve-return-request"
import { issueWalletCreditWorkflow } from "./issue-wallet-credit"

export type ApproveReturnRequestInput = {
  request_id: string
  /** Wallet credit to issue, in rupees. */
  amount: number
  note?: string
  approved_by?: string
}

/**
 * Approves a return or exchange request: issues the agreed amount as wallet
 * credit, then marks the request approved. If either part fails, both are
 * undone, so a request is never approved without the credit or the other way
 * round.
 */
export const approveReturnRequestWorkflow = createWorkflow(
  "approve-return-request",
  function (input: ApproveReturnRequestInput) {
    const lockKey = transform({ input }, (data) => `return-request:${data.input.request_id}`)
    acquireLockStep({ key: lockKey, timeout: 30, ttl: 60 })

    const request = getPendingReturnRequestStep({ request_id: input.request_id })

    issueWalletCreditWorkflow.runAsStep({
      input: transform({ input, request }, (data) => ({
        customer_id: data.request.customer_id,
        amount: data.input.amount,
        reason: data.request.type,
        order_id: data.request.order_id,
        note: data.input.note ?? `${data.request.type === "exchange" ? "Exchange" : "Return"} request approved`,
        created_by: data.input.approved_by,
      })),
    })

    const resolved = resolveReturnRequestStep(
      transform({ input }, (data) => ({
        request_id: data.input.request_id,
        status: "approved" as const,
        credit_amount: data.input.amount,
        resolution_note: data.input.note ?? null,
        resolved_by: data.input.approved_by ?? null,
      }))
    )

    releaseLockStep({ key: lockKey })

    return new WorkflowResponse(resolved)
  }
)
