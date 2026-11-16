import { MedusaService } from "@medusajs/framework/utils"
import { ProductReview } from "./models/product-review"
import { ReviewNotification } from "./models/review-notification"
import { ReviewPhoto } from "./models/review-photo"
import { ReviewRequest } from "./models/review-request"

class ProductReviewModuleService extends MedusaService({
  ProductReview,
  ReviewImage: ReviewPhoto,
  ReviewRequest,
  ReviewNotification,
}) {}

export default ProductReviewModuleService
