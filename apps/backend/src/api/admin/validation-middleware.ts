import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"

/**
 * Wraps a plain parser as Medusa middleware: the parsed body lands on
 * `req.validatedBody`, and a thrown MedusaError becomes the usual 400 response.
 */
export function validatedBody(parse: (body: unknown) => unknown) {
  return (req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) => {
    try {
      req.validatedBody = parse(req.body)
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Same as validatedBody, for the query string (`req.validatedQuery`). */
export function validatedQuery(parse: (query: unknown) => unknown) {
  return (req: MedusaRequest, _res: MedusaResponse, next: MedusaNextFunction) => {
    try {
      req.validatedQuery = parse(req.query) as Record<string, unknown>
      next()
    } catch (error) {
      next(error)
    }
  }
}
