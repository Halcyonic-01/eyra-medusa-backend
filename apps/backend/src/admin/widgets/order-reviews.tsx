import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { sdk } from "../lib/client"

type Notification = {
  id: string
  stage: "request" | "reminder"
  channel: "email" | "whatsapp"
  status: string
  due_at: string
  sent_at: string | null
  attempts: number
  detail: string | null
}

type ReviewRequestResponse = {
  review_request: {
    created_at: string
    whatsapp_opt_in: boolean
    opened_at: string | null
    completed_at: string | null
    token_used_at: string | null
    token_expires_at: string
    notifications: Notification[]
  } | null
  reviews: { id: string; product_title: string | null; rating: number; status: string }[]
}

const STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey" | "blue"> = {
  sent: "green",
  scheduled: "blue",
  pending: "orange",
  sending: "orange",
  failed: "red",
  gave_up: "red",
  skipped: "grey",
  cancelled: "grey",
}

const DETAIL: Record<string, string> = {
  no_consent: "no WhatsApp consent",
  no_phone: "no mobile number",
  no_email: "no email",
  reviewed: "already reviewed",
  storefront_not_configured: "not set up",
  not_configured: "provider not set up",
  outcome_unknown: "result unknown, not resent",
  too_many_attempts: "failed 5 times",
  email_not_sent: "email provider did not send it, retrying",
  storefront_unreachable: "storefront unreachable, retrying",
  link_closed: "link used or expired",
  order_not_reviewable: "order not reviewable",
  emails_disabled: "customer emails switched off",
  no_storefront_url: "storefront address not set",
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null

/** The order's review request: what was sent, whether the customer opened the link, and what they wrote. */
const OrderReviewsWidget = ({ data: order }: DetailWidgetProps<AdminOrder>) => {
  const { data, isLoading } = useQuery({
    queryKey: ["order-review-request", order.id],
    queryFn: () => sdk.client.fetch<ReviewRequestResponse>(`/admin/orders/${order.id}/review-request`),
  })
  const link = useMutation({
    mutationFn: () => sdk.client.fetch<{ url: string | null }>(`/admin/orders/${order.id}/review-request/link`, { method: "POST" }),
    onSuccess: async (reply) => {
      if (!reply.url) return toast.error("The storefront address is not set, so no link can be made.")
      try {
        await navigator.clipboard.writeText(reply.url)
        toast.success("New review link copied. The old link no longer works.")
      } catch {
        toast.info(reply.url)
      }
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const request = data?.review_request
  const order_of = (n: Notification) => (n.stage === "request" ? 0 : 2) + (n.channel === "email" ? 0 : 1)

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Review request</Heading>
        {request?.completed_at ? (
          <Badge color="green" size="2xsmall">
            Reviewed
          </Badge>
        ) : request?.opened_at ? (
          <Badge color="blue" size="2xsmall">
            Link opened
          </Badge>
        ) : null}
      </div>
      {isLoading ? (
        <Text size="small" className="text-ui-fg-subtle px-6 py-4">
          Loading…
        </Text>
      ) : !request ? (
        <Text size="small" className="text-ui-fg-subtle px-6 py-4">
          Sent automatically once the order is delivered.
        </Text>
      ) : (
        <div className="flex flex-col gap-y-2 px-6 py-4">
          {[...request.notifications].sort((a, b) => order_of(a) - order_of(b)).map((n) => (
            <div key={n.id} className="flex items-center justify-between gap-x-2">
              <Text size="small">
                {n.stage === "request" ? "Request" : "Reminder"} by {n.channel === "email" ? "email" : "WhatsApp"}
              </Text>
              <div className="flex items-center gap-x-2">
                <Text size="xsmall" className="text-ui-fg-subtle">
                  {n.status === "sent" ? when(n.sent_at) : n.status === "scheduled" ? when(n.due_at) : DETAIL[n.detail ?? ""] ?? n.detail ?? ""}
                </Text>
                <Badge color={STATUS_COLOR[n.status] ?? "grey"} size="2xsmall">
                  {n.status.replace("_", " ")}
                </Badge>
              </div>
            </div>
          ))}
          <Text size="xsmall" className="text-ui-fg-subtle pt-1">
            {request.token_used_at
              ? `Link used ${when(request.token_used_at)}`
              : `Link works until ${when(request.token_expires_at)}`}
          </Text>
        </div>
      )}
      {(data?.reviews.length ?? 0) > 0 && (
        <div className="flex flex-col gap-y-1 px-6 py-4">
          {data!.reviews.map((review) => (
            <a key={review.id} href="/app/reviews" className="flex items-center justify-between">
              <Text size="small">{review.product_title}</Text>
              <Text size="small" className="text-ui-tag-orange-icon">
                {"★".repeat(review.rating)} <span className="text-ui-fg-subtle">{review.status}</span>
              </Text>
            </a>
          ))}
        </div>
      )}
      <div className="px-6 py-4">
        <Button size="small" variant="secondary" onClick={() => link.mutate()} isLoading={link.isPending}>
          Copy a new review link
        </Button>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default OrderReviewsWidget
