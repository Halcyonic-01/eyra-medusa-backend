import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CreditCard } from "@medusajs/icons"
import {
  Badge,
  Button,
  Container,
  FocusModal,
  Heading,
  Input,
  Label,
  Select,
  Table,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { sdk } from "../../lib/client"

type Transaction = {
  id: string
  type: "issued" | "redeemed" | "refunded" | "expired"
  reason: "return" | "exchange" | "cancellation" | null
  amount: number
  balance_after: number
  remaining: number
  expires_at: string | null
  order_id: string | null
  note: string | null
  created_at: string
}

type WalletResponse = {
  wallet: {
    id: string | null
    customer_id: string
    currency_code: string
    balance: number
    /** The credit that lapses first, so staff and customers are not surprised. */
    next_expiry: { amount: number; expires_at: string | null } | null
    transactions: Transaction[]
  }
}

type CustomerSummary = {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
}

type OrderSummary = {
  id: string
  display_id: number
  total: number
  created_at: string
}

const MAX_AMOUNT = 1000000

function rupees(amount: number): string {
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
}

const TYPE_LABELS: Record<Transaction["type"], { label: string; color: "green" | "grey" | "blue" | "orange" }> = {
  issued: { label: "Issued", color: "green" },
  refunded: { label: "Refunded", color: "blue" },
  redeemed: { label: "Used", color: "grey" },
  expired: { label: "Expired", color: "orange" },
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-IN") : "-"
}

function customerName(customer: CustomerSummary): string {
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ")
  return name ? `${name} (${customer.email})` : customer.email
}

/** Waits for typing to pause before it is used for a search. */
function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

const IssueCreditModal = ({
  customer,
  open,
  onOpenChange,
}: {
  customer: CustomerSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) => {
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState<"return" | "exchange">("return")
  const [orderId, setOrderId] = useState("")
  const [note, setNote] = useState("")
  const [error, setError] = useState("")

  // The customer's own orders, so credit is tied to an order they really placed.
  const { data: orders, isLoading: ordersLoading } = useQuery({
    queryKey: ["wallet-customer-orders", customer.id],
    queryFn: () =>
      sdk.client.fetch<{ orders: OrderSummary[] }>("/admin/orders", {
        query: {
          customer_id: customer.id,
          limit: 20,
          order: "-created_at",
          fields: "id,display_id,total,created_at",
        },
      }),
    enabled: open,
  })

  const issue = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      sdk.client.fetch("/admin/wallets/credits", { method: "POST", body }),
    onSuccess: () => {
      // The wallet on screen shows balance and history, so refresh it.
      queryClient.invalidateQueries({ queryKey: ["wallet", customer.id] })
      toast.success("Credit added to the wallet")
      setAmount("")
      setOrderId("")
      setNote("")
      setError("")
      onOpenChange(false)
    },
    onError: (err: Error) => {
      toast.error(err.message || "Could not issue credit")
    },
  })

  const submit = () => {
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
    issue.mutate({
      customer_id: customer.id,
      amount: value,
      reason,
      ...(orderId ? { order_id: orderId } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    })
  }

  return (
    <FocusModal open={open} onOpenChange={onOpenChange}>
      <FocusModal.Content>
        <div className="flex h-full flex-col overflow-hidden">
          <FocusModal.Header>
            <FocusModal.Title className="sr-only">Issue wallet credit</FocusModal.Title>
            <div className="flex items-center justify-end gap-x-2">
              <FocusModal.Close asChild>
                <Button size="small" variant="secondary" disabled={issue.isPending}>
                  Cancel
                </Button>
              </FocusModal.Close>
              <Button size="small" onClick={submit} isLoading={issue.isPending}>
                Issue credit
              </Button>
            </div>
          </FocusModal.Header>

          <FocusModal.Body className="flex-1 overflow-auto">
            <div className="mx-auto flex w-full max-w-[560px] flex-col gap-y-6 py-8">
              <div>
                <Heading level="h2">Issue wallet credit</Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  For {customerName(customer)}. The customer can spend it at checkout until it expires.
                </Text>
              </div>

              <div className="flex flex-col gap-y-2">
                <Label>Reason</Label>
                <Select
                  value={reason}
                  onValueChange={(value) => setReason(value as "return" | "exchange")}
                >
                  <Select.Trigger>
                    <Select.Value placeholder="Select a reason" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="return">Return</Select.Item>
                    <Select.Item value="exchange">Exchange</Select.Item>
                  </Select.Content>
                </Select>
              </div>

              <div className="flex flex-col gap-y-2">
                <Label>Amount (₹)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="1499"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value)
                    setError("")
                  }}
                />
                {error && (
                  <Text size="small" className="text-ui-fg-error">
                    {error}
                  </Text>
                )}
                <Text size="small" className="text-ui-fg-subtle">
                  Whole rupees are spent at checkout; any paise stay in the wallet.
                </Text>
              </div>

              <div className="flex flex-col gap-y-2">
                <Label>Order being returned or exchanged (optional)</Label>
                <Select value={orderId} onValueChange={setOrderId} disabled={ordersLoading}>
                  <Select.Trigger>
                    <Select.Value
                      placeholder={ordersLoading ? "Loading orders..." : "Select an order"}
                    />
                  </Select.Trigger>
                  <Select.Content>
                    {(orders?.orders ?? []).map((order) => (
                      <Select.Item key={order.id} value={order.id}>
                        {`#${order.display_id} - ${rupees(order.total)} - ${new Date(
                          order.created_at
                        ).toLocaleDateString("en-IN")}`}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select>
                {!ordersLoading && (orders?.orders ?? []).length === 0 && (
                  <Text size="small" className="text-ui-fg-subtle">
                    This customer has no orders on their account.
                  </Text>
                )}
              </div>

              <div className="flex flex-col gap-y-2">
                <Label>Note (optional)</Label>
                <Textarea
                  placeholder="For example: ring returned unworn, size too small"
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Text size="small" className="text-ui-fg-subtle">
                  The customer sees this note in their wallet history.
                </Text>
              </div>
            </div>
          </FocusModal.Body>
        </div>
      </FocusModal.Content>
    </FocusModal>
  )
}

const WalletPage = () => {
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounced(search.trim(), 300)
  const [customer, setCustomer] = useState<CustomerSummary | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  // Customer search results; they only make sense once something is typed.
  const { data: results, isFetching: searching } = useQuery({
    queryKey: ["wallet-customer-search", debouncedSearch],
    queryFn: () =>
      sdk.admin.customer.list({
        q: debouncedSearch,
        limit: 8,
        fields: "id,email,first_name,last_name",
      }),
    enabled: debouncedSearch.length >= 2,
  })

  // The selected customer's wallet: this is what the page shows.
  const { data: walletData, isLoading: walletLoading } = useQuery({
    queryKey: ["wallet", customer?.id],
    queryFn: () =>
      sdk.client.fetch<WalletResponse>("/admin/wallets", {
        query: { customer_id: customer?.id, limit: 50 },
      }),
    enabled: Boolean(customer),
  })

  const wallet = walletData?.wallet
  const matches = (results?.customers ?? []) as CustomerSummary[]

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h1">Wallet</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Store credit for returns and exchanges. Find a customer to see their wallet or issue credit.
          </Text>
        </div>

        <div className="flex flex-col gap-y-3 px-6 py-4">
          <Label>Find a customer</Label>
          <Input
            type="search"
            placeholder="Search by email or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {debouncedSearch.length >= 2 && (
            <div className="flex flex-col gap-y-1">
              {searching && (
                <Text size="small" className="text-ui-fg-subtle">
                  Searching...
                </Text>
              )}
              {!searching && matches.length === 0 && (
                <Text size="small" className="text-ui-fg-subtle">
                  No customers found.
                </Text>
              )}
              {matches.map((match) => (
                <Button
                  key={match.id}
                  size="small"
                  variant={customer?.id === match.id ? "primary" : "secondary"}
                  className="justify-start"
                  onClick={() => setCustomer(match)}
                >
                  {customerName(match)}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Container>

      {customer && (
        <Container className="divide-y p-0">
          <div className="flex items-center justify-between px-6 py-4">
            <div>
              <Text size="small" leading="compact" weight="plus">
                {customerName(customer)}
              </Text>
              <Text size="small" leading="compact" className="text-ui-fg-subtle">
                {walletLoading || !wallet ? "Loading wallet..." : `Balance ${rupees(wallet.balance)}`}
              </Text>
              {wallet?.next_expiry?.expires_at && (
                <Text size="small" leading="compact" className="text-ui-fg-subtle">
                  {`${rupees(wallet.next_expiry.amount)} expires on ${formatDate(wallet.next_expiry.expires_at)}`}
                </Text>
              )}
            </div>
            <Button size="small" onClick={() => setModalOpen(true)}>
              Issue credit
            </Button>
          </div>

          <div className="px-6 py-4">
            {walletLoading || !wallet ? (
              <Text size="small" className="text-ui-fg-subtle">
                Loading history...
              </Text>
            ) : wallet.transactions.length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle">
                No wallet activity yet.
              </Text>
            ) : (
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Date</Table.HeaderCell>
                    <Table.HeaderCell>Type</Table.HeaderCell>
                    <Table.HeaderCell>Reason</Table.HeaderCell>
                    <Table.HeaderCell>Amount</Table.HeaderCell>
                    <Table.HeaderCell>Expires</Table.HeaderCell>
                    <Table.HeaderCell>Balance after</Table.HeaderCell>
                    <Table.HeaderCell>Note</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {wallet.transactions.map((t) => (
                    <Table.Row key={t.id}>
                      <Table.Cell>{new Date(t.created_at).toLocaleDateString("en-IN")}</Table.Cell>
                      <Table.Cell>
                        <Badge size="2xsmall" color={TYPE_LABELS[t.type].color}>
                          {TYPE_LABELS[t.type].label}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>{t.reason ?? "-"}</Table.Cell>
                      <Table.Cell>
                        {t.type === "issued" || t.type === "refunded" ? "+" : "-"}
                        {rupees(t.amount)}
                      </Table.Cell>
                      <Table.Cell>
                        {t.type === "issued" || t.type === "refunded"
                          ? `${formatDate(t.expires_at)}${t.remaining < t.amount ? ` (${rupees(t.remaining)} left)` : ""}`
                          : "-"}
                      </Table.Cell>
                      <Table.Cell>{rupees(t.balance_after)}</Table.Cell>
                      <Table.Cell>{t.note ?? "-"}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </div>
        </Container>
      )}

      {customer && (
        <IssueCreditModal customer={customer} open={modalOpen} onOpenChange={setModalOpen} />
      )}
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Wallet",
  icon: CreditCard,
})

export default WalletPage
