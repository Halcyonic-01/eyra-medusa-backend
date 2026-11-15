import type { MiddlewareRoute } from "@medusajs/framework/http"
import { validatedBody, validatedQuery } from "./admin/validation-middleware"
import {
  parseAdminReviews,
  parseCustomerOrder,
  parseCustomerPhoto,
  parseCustomerReviews,
  parseLinkPhoto,
  parseLinkReviews,
  parseModerate,
  parseProductReviews,
  parseReviewLink,
  parseWhatsappConsent,
} from "./review-validation"

// A photo arrives as base64 in JSON: up to 3 MB of image is about 4 MB of text.
const photoBody = { sizeLimit: "5mb" }

export const reviewMiddlewares: MiddlewareRoute[] = [
  { matcher: "/store/product-reviews", method: "GET", middlewares: [validatedQuery(parseProductReviews)] },
  { matcher: "/store/review-links/session", method: "POST", middlewares: [validatedBody(parseReviewLink)] },
  { matcher: "/store/review-links/reviews", method: "POST", middlewares: [validatedBody(parseLinkReviews)] },
  { matcher: "/store/review-links/photos", method: "POST", bodyParser: photoBody, middlewares: [validatedBody(parseLinkPhoto)] },
  { matcher: "/store/carts/:id/whatsapp-consent", method: "POST", middlewares: [validatedBody(parseWhatsappConsent)] },
  { matcher: "/admin/product-reviews", method: "GET", middlewares: [validatedQuery(parseAdminReviews)] },
  { matcher: "/admin/product-reviews/moderate", method: "POST", middlewares: [validatedBody(parseModerate)] },
  { matcher: "/admin/product-reviews/customer", method: "GET", middlewares: [validatedQuery(parseCustomerOrder)] },
  { matcher: "/admin/product-reviews/customer", method: "POST", middlewares: [validatedBody(parseCustomerReviews)] },
  { matcher: "/admin/product-reviews/customer/photos", method: "POST", bodyParser: photoBody, middlewares: [validatedBody(parseCustomerPhoto)] },
]
