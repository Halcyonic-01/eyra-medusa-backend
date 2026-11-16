/** What a shopper may see of a review: never the email, order or customer. */
export function publicReview(review: any) {
  return {
    id: review.id,
    rating: Number(review.rating),
    title: review.title ?? null,
    body: review.body,
    display_name: review.display_name,
    variant_title: review.variant_title ?? null,
    verified_purchase: Boolean(review.verified_purchase),
    submitted_at: review.submitted_at,
    edited: Boolean(review.edited_at),
    photos: (review.photos ?? [])
      .filter((photo: any) => photo.status === "attached")
      .map((photo: any) => ({ id: photo.id, url: photo.url })),
  }
}
