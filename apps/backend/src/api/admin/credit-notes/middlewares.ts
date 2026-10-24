import type { MiddlewareRoute } from "@medusajs/framework/http"
import { validatedQuery } from "../validation-middleware"
import { parseGstr1, parseListCreditNotes } from "./validation"

export const creditNoteMiddlewares: MiddlewareRoute[] = [
  { matcher: "/admin/credit-notes", method: "GET", middlewares: [validatedQuery(parseListCreditNotes)] },
  { matcher: "/admin/credit-notes/gstr1", method: "GET", middlewares: [validatedQuery(parseGstr1)] },
]
