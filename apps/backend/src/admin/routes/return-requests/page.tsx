import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ArrowUturnLeft } from "@medusajs/icons"
import {
  Badge,
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  Table,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { sdk } from "../../lib/client"

type Status =
  | "pending"
  | "pending_fee"
  | "reverse_pickup_scheduled"
  | "awaiting_inspection"
  | "approved"
  | "rejected"

type ReturnRequest = {
  id: string
  order_id: string
  order_display_id: number | null
  customer: { email: string; first_name: string | null; last_name: string | null } | null
  type: "return" | "exchange"
  reason: string
  note: string | null
  items: { item_id: string; title: string; quantity: number; total: number }[]
  items_total: number
  status: Status
  credit_amount: number | null
  resolution_note: string | null
  created_at: string
  paid_value: number | null
  fee_amount: number | null
  reverse: { order_ref: string | null; awb: string | null; error: string | null }
  exchange: {
    replacement_title: string | null
    price_difference: number | null
    amount_due: number | null
    fee_link_url: string | null
    fee_paid_at: string | null
    payment_required: boolean
    replacement_order_id: string | null
  } | null
  credit_note_id: string | null
  received_at: string | null
}

const STATUSES: { value: Status; label: string }[] = [
  { value: "pending", label: "Needs us" },
  { value: "pending_fee", label: "Waiting for payment" },
  { value: "reverse_pickup_scheduled", label: "Pickup booked" },
  { value: "awaiting_inspection", label: "To inspect" },
  { value: "approved", label: "Completed" },
  { value: "rejected", label: "Declined" },
]

const STATUS_COLORS: Record<Status, "orange" | "green" | "grey" | "blue" | "purple"> = {
  pending: "orange",
  pending_fee: "purple",
  reverse_pickup_scheduled: "blue",
  awaiting_inspection: "blue",
  approved: "green",
  rejected: "grey",
}

const STATUS_TEXT: Record<Status, string> = {
  pending: "Needs us",
  pending_fee: "Waiting for payment",
  reverse_pickup_scheduled: "Pickup booked",
  awaiting_inspection: "To inspect",
  approved: "Completed",
  rejected: "Declined",
}

const REASON_LABELS: Record<string, string> = {
  SIZE_ISSUE: "Size issue",
  DESIGN_PREFERENCE: "Design preference",
  DAMAGED_IN_TRANSIT: "Damaged in transit (unboxing video needed)",
  DEFECTIVE: "Defective (unboxing video needed)",
  wrong_size: "Wrong size",
  damaged_or_defective: "Damaged or defective",
  not_as_described: "Not as described",
  changed_mind: "Changed mind",
  other: "Other",
}

const MAX_AMOUNT = 1000000

function rupees(amount: number): string {
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
}

function who(request: ReturnRequest): string {
  const customer = request.customer
  if (!customer) {
    return "Unknown customer"
  }
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ")
  return name ? `${name} (${customer.email})` : customer.email
}

const DecisionModal = ({
  request,
  mode,
  onClose,
}: {
  request: ReturnRequest
  mode: "approve" | "reject"
  onClose: () => void
}) => {
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState(String(request.items_total))
  const [note, setNote] = useState("")
  const [error, setError] = useState("")

  const decide = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      sdk.client.fetch(`/admin/return-requests/${request.id}/${mode}`, { method: "POST", body }),
    onSuccess: () => {
      // The page lists requests by status, so refresh all of them; an approval
      // also changes the customer's wallet.
      queryClient.invalidateQueries({ queryKey: ["return-requests"] })
      queryClient.invalidateQueries({ queryKey: ["wallet"] })
      toast.success(mode === "approve" ? "Request approved and credit issued" : "Request declined")
      onClose()
    },
    onError: (err: Error) => {
      toast.error(err.message || "Could not save your decision")
    },
  })

  const submit = () => {
    if (mode === "approve") {
      const value = Number(amount)
      if (!amount || !Number.isFinite(value) || value <= 0) {
        setError("Enter an amount greater than 0")
        return
      }
      if (value > MAX_AMOUNT) {
        setError(`The most you can issue at once is ${rupees(MAX_AMOUNT)}`)
        return
      }
      if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        setError("Use at most two decimal places")
        return
      }
      setError("")
      decide.mutate({ amount: value, ...(note.trim() ? { note: note.trim() } : {}) })
      return
    }

    if (!note.trim()) {
      setError("Tell the customer why, so they are not left guessing")
      return
    }
    setError("")
    decide.mutate({ note: note.trim() })
  }

  return (
    <FocusModal open onOpenChange={(open) => !open && onClose()}>
      <FocusModal.Content>
        <div className="flex h-full flex-col overflow-hidden">
          <FocusModal.Header>
            <FocusModal.Title className="sr-only">
              {mode === "approve" ? "Approve request" : "Decline request"}
            </FocusModal.Title>
            <div className="flex items-center justify-end gap-x-2">
              <FocusModal.Close asChild>
                <Button size="small" variant="secondary" disabled={decide.isPending}>
                  Cancel
                </Button>
              </FocusModal.Close>
              <Button
                size="small"
                variant={mode === "approve" ? "primary" : "danger"}
                onClick={submit}
                isLoading={decide.isPending}
              >
                {mode === "approve" ? "Approve and issue credit" : "Decline request"}
              </Button>
            </div>
          </FocusModal.Header>

          <FocusModal.Body className="flex-1 overflow-auto">
            <div className="mx-auto flex w-full max-w-[560px] flex-col gap-y-6 py-8">
              <div>
                <Heading level="h2">
                  {mode === "approve" ? "Approve" : "Decline"} {request.type} request
                </Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  {who(request)}, order #{request.order_display_id ?? "?"}
                </Text>
              </div>

              <div className="flex flex-col gap-y-1">
                {request.items.map((item) => (
                  <Text key={item.item_id} size="small">
                    {item.quantity} x {item.title} ({rupees(item.total)})
                  </Text>
                ))}
                <Text size="small" className="text-ui-fg-subtle">
                  {REASON_LABELS[request.reason] ?? request.reason}
                  {request.note ? `: ${request.note}` : ""}
                </Text>
              </div>

              {mode === "approve" && (
                <div className="flex flex-col gap-y-2">
                  <Label>Credit to issue (₹)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value)
                      setError("")
                    }}
                  />
                  <Text size="small" className="text-ui-fg-subtle">
                    Starts at the value of the items. Change it if you are deducting for wear
                    or adding the shipping charge.
                  </Text>
                </div>
              )}

              <div className="flex flex-col gap-y-2">
                <Label>{mode === "approve" ? "Note (optional)" : "Reason for declining"}</Label>
                <Textarea
                  value={note}
                  maxLength={500}
                  placeholder={
                    mode === "approve"
                      ? "For example: inspected, approved in full"
                      : "For example: the ring shows signs of wear"
                  }
                  onChange={(e) => {
                    setNote(e.target.value)
                    setError("")
                  }}
                />
                <Text size="small" className="text-ui-fg-subtle">
                  {mode === "approve"
                    ? "The customer sees this in their wallet history and in the email."
                    : "The customer is emailed this."}
                </Text>
                {error && (
                  <Text size="small" className="text-ui-fg-error">
                    {error}
                  </Text>
                )}
              </div>
            </div>
          </FocusModal.Body>
        </div>
      </FocusModal.Content>
    </FocusModal>
  )
}

const ReturnRequestsPage = () => {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>("pending")
  const [decision, setDecision] = useState<{ request: ReturnRequest; mode: "approve" | "reject" } | null>(null)

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "received" | "retry-pickup" }) =>
      sdk.client.fetch(`/admin/return-requests/${id}/${action}`, { method: "POST", body: {} }),
    onSuccess: (_data, { action }) => {
      queryClient.invalidateQueries({ queryKey: ["return-requests"] })
      queryClient.invalidateQueries({ queryKey: ["wallet"] })
      toast.success(
        action === "received"
          ? "Marked received. The credit note and store credit (or the replacement) are being issued."
          : "Pickup requested"
      )
    },
    onError: (err: Error) => toast.error(err.message || "That did not work"),
  })

  const { data, isLoading } = useQuery({
    queryKey: ["return-requests", status],
    queryFn: () =>
      sdk.client.fetch<{ return_requests: ReturnRequest[]; count: number }>("/admin/return-requests", {
        query: { status, limit: 50 },
      }),
  })

  const requests = data?.return_requests ?? []

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">Return and exchange requests</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Returns book the courier at once; when the item reaches you and passes the check, press Mark received and
            the credit note, the store credit (item value less the ₹99 reverse fee, valid 12 months) or the
            replacement for an exchange follow by themselves. Approve is only for older requests that wait for you.
          </Text>
        </div>

        <div className="flex items-center gap-x-2 px-6 py-3">
          {STATUSES.map((entry) => (
            <Button
              key={entry.value}
              size="small"
              variant={status === entry.value ? "primary" : "secondary"}
              onClick={() => setStatus(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>

        <div className="px-6 py-4">
          {isLoading ? (
            <Text size="small" className="text-ui-fg-subtle">
              Loading requests...
            </Text>
          ) : requests.length === 0 ? (
            <Text size="small" className="text-ui-fg-subtle">
              No requests here.
            </Text>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Date</Table.HeaderCell>
                  <Table.HeaderCell>Customer</Table.HeaderCell>
                  <Table.HeaderCell>Order</Table.HeaderCell>
                  <Table.HeaderCell>Type</Table.HeaderCell>
                  <Table.HeaderCell>Items</Table.HeaderCell>
                  <Table.HeaderCell>Value</Table.HeaderCell>
                  <Table.HeaderCell>Reason</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {requests.map((request) => (
                  <Table.Row key={request.id}>
                    <Table.Cell>{new Date(request.created_at).toLocaleDateString("en-IN")}</Table.Cell>
                    <Table.Cell>{who(request)}</Table.Cell>
                    <Table.Cell>#{request.order_display_id ?? "?"}</Table.Cell>
                    <Table.Cell>{request.type}</Table.Cell>
                    <Table.Cell>
                      {request.items.map((item) => `${item.quantity} x ${item.title}`).join(", ")}
                    </Table.Cell>
                    <Table.Cell>
                      {rupees(request.paid_value ?? request.items_total)}
                      {request.type === "return" && request.fee_amount ? (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          less {rupees(request.fee_amount)} fee
                        </Text>
                      ) : null}
                    </Table.Cell>
                    <Table.Cell>
                      {REASON_LABELS[request.reason] ?? request.reason}
                      {request.note ? ` - ${request.note}` : ""}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="2xsmall" color={STATUS_COLORS[request.status]}>
                        {STATUS_TEXT[request.status] ?? request.status}
                      </Badge>
                      {request.exchange && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          For {request.exchange.replacement_title ?? "a replacement"}
                          {request.exchange.payment_required
                            ? `; difference ${rupees(request.exchange.amount_due ?? 0)}${request.exchange.fee_paid_at ? " (paid)" : " (to pay)"}`
                            : "; no payment due"}
                        </Text>
                      )}
                      {request.reverse.awb && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          Pickup AWB {request.reverse.awb}
                        </Text>
                      )}
                      {request.reverse.error && (
                        <Text size="xsmall" className="text-ui-fg-error">
                          {request.reverse.error}
                        </Text>
                      )}
                      {request.status === "approved" && request.credit_amount !== null && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          {rupees(request.credit_amount)} credit
                        </Text>
                      )}
                      {request.status === "rejected" && request.resolution_note && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          {request.resolution_note}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex items-center gap-x-2">
                        {["pending", "reverse_pickup_scheduled", "awaiting_inspection"].includes(request.status) &&
                          (request.type === "return" || !request.exchange?.payment_required || request.exchange?.fee_paid_at) && (
                            <Button
                              size="small"
                              onClick={() => act.mutate({ id: request.id, action: "received" })}
                              isLoading={act.isPending}
                            >
                              Mark received
                            </Button>
                          )}
                        {request.status === "pending" && (request.type === "return" || !request.exchange?.payment_required || request.exchange?.fee_paid_at) && (
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => act.mutate({ id: request.id, action: "retry-pickup" })}
                            isLoading={act.isPending}
                          >
                            Retry pickup
                          </Button>
                        )}
                        {request.status === "pending" && (
                          <Button size="small" variant="secondary" onClick={() => setDecision({ request, mode: "approve" })}>
                            Approve for an amount
                          </Button>
                        )}
                        {["pending", "pending_fee", "reverse_pickup_scheduled", "awaiting_inspection"].includes(request.status) && (
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => setDecision({ request, mode: "reject" })}
                          >
                            Decline
                          </Button>
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </div>
      </Container>

      {decision && (
        <DecisionModal
          key={decision.request.id + decision.mode}
          request={decision.request}
          mode={decision.mode}
          onClose={() => setDecision(null)}
        />
      )}
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Returns",
  icon: ArrowUturnLeft,
})

export default ReturnRequestsPage
