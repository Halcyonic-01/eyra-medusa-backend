import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { issueWalletCreditWorkflow } from "../../../../workflows/issue-wallet-credit"
import type { IssueWalletCreditBody } from "../validation"

/**
 * POST /admin/wallets/credits
 *
 * Issues store credit for an approved return or exchange.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<IssueWalletCreditBody>,
  res: MedusaResponse
) {
  const { result } = await issueWalletCreditWorkflow(req.scope).run({
    input: {
      ...req.validatedBody,
      created_by: req.auth_context?.actor_id,
    },
  })

  return res.status(201).json(result)
}
