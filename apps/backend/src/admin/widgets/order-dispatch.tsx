import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminOrder, DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Button, Container, Heading, Text, toast, usePrompt } from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { sdk } from "../lib/client"

type Dispatch = {
  state: "placed" | "dispatching" | "dispatch_failed" | "shipped" | "cancelling" | "cancelled"
  window_ends_at: string
  shipped_at: string | null
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  shiprocket_shipment_id: string | null
  awb_code: string | null
  courier_name: string | null
  label_url: string | null
  pickup_scheduled: boolean | null
  invoice_number: string | null
}

type Cancellation = {
  requested_by: "customer" | "staff"
  reason: string | null
  refund_method: "wallet" | "original" | "none"
  paid_online: number
  wallet_used: number
  fee: number
  refund_amount: number
  status: "processing" | "completed" | "needs_attention"
  refund_status: "not_needed" | "pending" | "initiated" | "credited" | "failed" | "unverified"
  refund_error: string | null
  razorpay_refund_id: string | null
}

type DispatchResponse = { dispatch: Dispatch | null; cancellation: Cancellation | null; config_problems?: string[] }

const REFUND_LABELS: Record<Cancellation["refund_status"], { label: string; color: "green" | "orange" | "red" | "grey" }> = {
  not_needed: { label: "Nothing to refund", color: "grey" },
  pending: { label: "Pending", color: "orange" },
  initiated: { label: "Refund started", color: "green" },
  credited: { label: "Credited to wallet", color: "green" },
  failed: { label: "Failed", color: "red" },
  unverified: { label: "Check Razorpay", color: "orange" },
}

const REASON_LABELS: Record<string, string> = {
  changed_mind: "Changed their mind",
  ordered_by_mistake: "Ordered by mistake",
  found_better_price: "Found a better price",
  delivery_time: "Delivery time",
  address_or_details: "Wrong address or details",
  other: "Other",
}

const rupees = (amount: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount)

const STATE_LABELS: Record<Dispatch["state"], { label: string; color: "green" | "orange" | "red" | "grey" | "blue" }> = {
  placed: { label: "Waiting", color: "orange" },
  dispatching: { label: "Shipping now", color: "blue" },
  dispatch_failed: { label: "Needs attention", color: "red" },
  shipped: { label: "Shipped", color: "green" },
  cancelling: { label: "Cancelling", color: "orange" },
  cancelled: { label: "Cancelled", color: "grey" },
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })

function timeLeft(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now
  if (ms <= 0) return "any moment now"
  const minutes = Math.ceil(ms / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 py-3">
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {label}
      </Text>
      <div className="text-right">{children}</div>
    </div>
  )
}

const OrderDispatchWidget = ({ data: order }: DetailWidgetProps<AdminOrder>) => {
  const queryClient = useQueryClient()
  const prompt = usePrompt()
  const [now, setNow] = useState(() => Date.now())

  const queryKey = ["order-dispatch", order.id]
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => sdk.client.fetch<DispatchResponse>(`/admin/orders/${order.id}/dispatch`),
    // Keeps the countdown and state fresh while the order is still moving.
    refetchInterval: (query) => {
      const state = query.state.data?.dispatch?.state
      return state === "shipped" || state === "cancelled" ? false : 15000
    },
  })

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  const shipNow = useMutation({
    mutationFn: () => sdk.client.fetch(`/admin/orders/${order.id}/dispatch`, { method: "POST" }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey })
      queryClient.invalidateQueries({ queryKey: ["order", order.id] })
      const outcome = result as { state?: string; error?: string | null }
      if (outcome.state === "shipped") {
        toast.success("Shipment created")
      } else if (outcome.error) {
        toast.error(`Could not create the shipment: ${outcome.error}`)
      }
    },
    onError: (err: Error) => toast.error(err.message || "Could not create the shipment"),
  })

  const retryRefund = useMutation({
    mutationFn: () =>
      sdk.client.fetch(`/admin/orders/${order.id}/cancellation/retry-refund`, { method: "POST" }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey })
      const outcome = result as { status?: string; refund_error?: string | null }
      if (outcome.status === "completed") {
        toast.success("Refund completed")
      } else {
        toast.error(outcome.refund_error || "The refund still could not be completed")
      }
    },
    onError: (err: Error) => toast.error(err.message || "Could not retry the refund"),
  })

  const releaseOrder = useMutation({
    mutationFn: () =>
      sdk.client.fetch(`/admin/orders/${order.id}/cancellation/release`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success("The order is back in its normal flow")
    },
    onError: (err: Error) => toast.error(err.message || "Could not release the order"),
  })

  const confirmRelease = async () => {
    const confirmed = await prompt({
      title: "Release this order?",
      description:
        "Only do this when no refund was sent. The order goes back to waiting, and will ship when its cancel window is over.",
      confirmText: "Release",
      cancelText: "Not yet",
    })
    if (confirmed) {
      releaseOrder.mutate()
    }
  }

  const confirmShipNow = async () => {
    const confirmed = await prompt({
      title: "Create the shipment now?",
      description:
        "This closes the customer's cancel window and books the courier, label and pickup in Shiprocket.",
      confirmText: "Ship now",
      cancelText: "Not yet",
    })
    if (confirmed) {
      shipNow.mutate()
    }
  }

  const dispatch = data?.dispatch ?? null
  const cancellation = data?.cancellation ?? null
  const badge = dispatch ? STATE_LABELS[dispatch.state] : null
  const canShip = dispatch === null || dispatch.state === "placed" || dispatch.state === "dispatch_failed"
  const cancelledOrder = order.status === "canceled"

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Shipping</Heading>
        {badge && (
          <Badge size="2xsmall" color={badge.color}>
            {badge.label}
          </Badge>
        )}
      </div>

      {(data?.config_problems ?? []).map((problem) => (
        <Text key={problem} size="small" className="px-6 py-3 text-ui-fg-error">
          Setup problem: {problem}.
        </Text>
      ))}

      {isLoading && (
        <Text size="small" className="px-6 py-4 text-ui-fg-subtle">
          Loading…
        </Text>
      )}

      {!isLoading && !dispatch && (
        <Text size="small" className="px-6 py-4 text-ui-fg-subtle">
          This order was placed before shipping was tracked here. If it has no shipment yet, you can create one now.
        </Text>
      )}

      {dispatch?.state === "placed" && (
        <>
          <Row label="Customer can cancel until">
            <Text size="small" leading="compact" weight="plus">
              {formatTime(dispatch.window_ends_at)}
            </Text>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              in {timeLeft(dispatch.window_ends_at, now)}
            </Text>
          </Row>
          <Text size="small" className="px-6 py-3 text-ui-fg-subtle">
            The shipment is created automatically when the window closes. Ship now to skip the wait.
          </Text>
        </>
      )}

      {dispatch?.state === "dispatching" && (
        <Text size="small" className="px-6 py-4 text-ui-fg-subtle">
          The courier order, label and pickup are being created.
        </Text>
      )}

      {dispatch?.state === "dispatch_failed" && (
        <>
          <Row label="Attempts">
            <Text size="small" leading="compact">
              {dispatch.attempts}
            </Text>
          </Row>
          {dispatch.last_error && (
            <Text size="small" className="px-6 py-3 text-ui-fg-error">
              {dispatch.last_error}
            </Text>
          )}
          {dispatch.next_attempt_at && (
            <Text size="small" className="px-6 pb-3 text-ui-fg-subtle">
              Next automatic try: {formatTime(dispatch.next_attempt_at)}
            </Text>
          )}
        </>
      )}

      {dispatch?.state === "shipped" && (
        <>
          {dispatch.shipped_at && (
            <Row label="Shipped">
              <Text size="small" leading="compact">
                {formatTime(dispatch.shipped_at)}
              </Text>
            </Row>
          )}
          <Row label="Courier">
            <Text size="small" leading="compact">
              {dispatch.courier_name || "Not assigned"}
            </Text>
          </Row>
          <Row label="AWB">
            <Text size="small" leading="compact">
              {dispatch.awb_code || "Not assigned"}
            </Text>
          </Row>
          <Row label="Pickup">
            <Text size="small" leading="compact">
              {dispatch.pickup_scheduled === null ? "Unknown" : dispatch.pickup_scheduled ? "Scheduled" : "Not scheduled"}
            </Text>
          </Row>
          {dispatch.label_url && (
            <Row label="Label">
              <a
                href={dispatch.label_url}
                target="_blank"
                rel="noopener noreferrer"
                className="txt-small text-ui-fg-interactive"
              >
                Download
              </a>
            </Row>
          )}
          {dispatch.invoice_number && (
            <Row label="Tax invoice">
              <Text size="small" leading="compact" weight="plus">
                {dispatch.invoice_number}
              </Text>
            </Row>
          )}
          {dispatch.last_error && (
            <Text size="small" className="px-6 py-3 text-ui-fg-error">
              {dispatch.last_error}. Finish it in the Shiprocket dashboard.
            </Text>
          )}
        </>
      )}

      {dispatch?.state === "cancelled" && !cancellation && (
        <Text size="small" className="px-6 py-4 text-ui-fg-subtle">
          This order was cancelled before a shipment was created.
        </Text>
      )}

      {cancellation && (
        <>
          <Row label="Cancelled by">
            <Text size="small" leading="compact">
              {cancellation.requested_by === "customer" ? "The customer" : "Staff"}
            </Text>
            {cancellation.reason && (
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {REASON_LABELS[cancellation.reason] ?? cancellation.reason}
              </Text>
            )}
          </Row>
          {cancellation.paid_online > 0 && (
            <>
              <Row label="Refunded to">
                <Text size="small" leading="compact">
                  {cancellation.refund_method === "wallet" ? "EYRA wallet" : "Original payment method"}
                </Text>
              </Row>
              <Row label="Paid online">
                <Text size="small" leading="compact">
                  {rupees(cancellation.paid_online)}
                </Text>
              </Row>
              {cancellation.fee > 0 && (
                <Row label="Cancellation fee kept">
                  <Text size="small" leading="compact">
                    {rupees(cancellation.fee)}
                  </Text>
                </Row>
              )}
              <Row label="Refund amount">
                <Text size="small" leading="compact" weight="plus">
                  {rupees(cancellation.refund_amount)}
                </Text>
              </Row>
            </>
          )}
          {cancellation.wallet_used > 0 && (
            <Row label="Wallet credit returned">
              <Text size="small" leading="compact">
                {rupees(cancellation.wallet_used)}
              </Text>
            </Row>
          )}
          <Row label="Refund">
            <Badge size="2xsmall" color={REFUND_LABELS[cancellation.refund_status].color}>
              {REFUND_LABELS[cancellation.refund_status].label}
            </Badge>
          </Row>
          {cancellation.razorpay_refund_id && (
            <Row label="Razorpay refund">
              <Text size="small" leading="compact">
                {cancellation.razorpay_refund_id}
              </Text>
            </Row>
          )}
          {cancellation.refund_error && (
            <Text size="small" className="px-6 py-3 text-ui-fg-error">
              {cancellation.refund_error}
            </Text>
          )}
          {(cancellation.refund_status === "failed" ||
            cancellation.refund_status === "unverified" ||
            cancellation.status === "needs_attention") && (
            <div className="flex justify-end px-6 py-4">
              <Button
                size="small"
                variant="secondary"
                onClick={() => retryRefund.mutate()}
                isLoading={retryRefund.isPending}
                disabled={retryRefund.isPending}
              >
                Retry refund
              </Button>
            </div>
          )}
        </>
      )}

      {dispatch?.state === "cancelling" &&
        (!cancellation || cancellation.refund_status === "pending" || cancellation.refund_status === "not_needed") && (
          <div className="flex justify-end px-6 py-4">
            <Button size="small" variant="secondary" onClick={confirmRelease} isLoading={releaseOrder.isPending}>
              Release order
            </Button>
          </div>
        )}

      {canShip && !cancelledOrder && (
        <div className="flex justify-end px-6 py-4">
          <Button
            size="small"
            variant="secondary"
            onClick={confirmShipNow}
            isLoading={shipNow.isPending}
            disabled={shipNow.isPending}
          >
            {dispatch?.state === "dispatch_failed" ? "Try again now" : "Ship now"}
          </Button>
        </div>
      )}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default OrderDispatchWidget
