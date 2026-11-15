import { defineRouteConfig } from "@medusajs/admin-sdk"
import { Star } from "@medusajs/icons"
import {
  Badge,
  Button,
  Checkbox,
  Container,
  Drawer,
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
import { useState } from "react"
import { sdk } from "../../lib/client"

type Status = "pending" | "approved" | "rejected"

type Review = {
  id: string
  product_id: string
  product_title: string | null
  variant_title: string | null
  order_id: string
  order_display_id: number | null
  customer_email: string | null
  rating: number
  title: string | null
  body: string
  display_name: string
  status: Status
  verified_purchase: boolean
  source: "link" | "account"
  flags: { signals?: string[] } | null
  rejection_reason: string | null
  moderation_note: string | null
  submitted_at: string
  edited_at: string | null
  moderated_at: string | null
  photos: { id: string; url: string; status: string }[]
}

type ListResponse = {
  reviews: Review[]
  count: number
  counts: Record<Status, number>
  rejection_reasons: Record<string, string>
}

const TABS: { value: Status; label: string }[] = [
  { value: "pending", label: "To check" },
  { value: "approved", label: "Published" },
  { value: "rejected", label: "Rejected" },
]

const STATUS_COLOR: Record<Status, "orange" | "green" | "grey"> = { pending: "orange", approved: "green", rejected: "grey" }
const STATUS_TEXT: Record<Status, string> = { pending: "To check", approved: "Published", rejected: "Rejected" }

const FLAG_TEXT: Record<string, string> = {
  link: "Has a link",
  contact_details: "Contact details",
  abusive_language: "Abusive words",
  gibberish: "Gibberish",
  all_capitals: "All capitals",
  duplicate_text: "Repeated text",
}

const PAGE = 20

const stars = (rating: number) => "★".repeat(rating) + "☆".repeat(5 - rating)
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })

function RejectModal({
  ids,
  reasons,
  lowRating,
  onClose,
}: {
  ids: string[]
  reasons: Record<string, string>
  lowRating: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState("")
  const [note, setNote] = useState("")
  const reject = useMutation({
    mutationFn: () => sdk.client.fetch("/admin/product-reviews/moderate", { method: "POST", body: { ids, action: "reject", reason, note } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-reviews"] })
      toast.success(ids.length === 1 ? "Review rejected" : `${ids.length} reviews rejected`)
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <FocusModal open onOpenChange={(open) => !open && onClose()}>
      <FocusModal.Content>
        <FocusModal.Header>
          <FocusModal.Title className="sr-only">Reject review</FocusModal.Title>
          <Button onClick={() => reject.mutate()} disabled={!reason || note.trim().length < 10} isLoading={reject.isPending} variant="danger">
            Reject {ids.length > 1 ? `${ids.length} reviews` : "review"}
          </Button>
        </FocusModal.Header>
        <FocusModal.Body className="flex flex-col items-center py-12">
          <div className="flex w-full max-w-lg flex-col gap-y-6">
            <div>
              <Heading>Reject {ids.length > 1 ? `${ids.length} reviews` : "this review"}</Heading>
              <Text className="text-ui-fg-subtle mt-2">
                A review can only be rejected for breaking the review policy. Honest negative reviews must be published.
              </Text>
              {lowRating && (
                <Text className="text-ui-fg-error mt-2" size="small">
                  This is a low rating. Only reject it if it breaks one of the rules below, not because it is negative.
                </Text>
              )}
            </div>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="reject-reason">Policy reason</Label>
              <Select value={reason} onValueChange={setReason}>
                <Select.Trigger id="reject-reason">
                  <Select.Value placeholder="Choose the rule it breaks" />
                </Select.Trigger>
                <Select.Content>
                  {Object.entries(reasons).map(([value, label]) => (
                    <Select.Item key={value} value={value}>
                      {label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>
            <div className="flex flex-col gap-y-2">
              <Label htmlFor="reject-note">What breaks the policy</Label>
              <Textarea id="reject-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="At least a sentence, kept on record" />
            </div>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  )
}

function ReviewDrawer({ review, onClose, onReject }: { review: Review; onClose: () => void; onReject: () => void }) {
  const queryClient = useQueryClient()
  const approve = useMutation({
    mutationFn: () => sdk.client.fetch("/admin/product-reviews/moderate", { method: "POST", body: { ids: [review.id], action: "approve" } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-reviews"] })
      toast.success("Review published")
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{review.product_title ?? "Review"}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-y-5 overflow-y-auto">
          <div className="flex items-center gap-x-2">
            <Text className="text-ui-tag-orange-icon text-lg tracking-wide">{stars(review.rating)}</Text>
            <Badge color={STATUS_COLOR[review.status]} size="2xsmall">
              {STATUS_TEXT[review.status]}
            </Badge>
            {review.verified_purchase && (
              <Badge color="blue" size="2xsmall">
                Verified purchase
              </Badge>
            )}
          </div>
          {review.title && <Heading level="h3">{review.title}</Heading>}
          <Text className="whitespace-pre-wrap">{review.body}</Text>
          {review.photos.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {review.photos.map((photo) => (
                <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer">
                  <img src={photo.url} alt="Customer photo" className="aspect-square w-full rounded-md object-cover" />
                </a>
              ))}
            </div>
          )}
          <div className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
            <Text size="small" className="text-ui-fg-subtle">Shown as</Text>
            <Text size="small">{review.display_name}</Text>
            <Text size="small" className="text-ui-fg-subtle">Customer</Text>
            <Text size="small">{review.customer_email ?? "-"}</Text>
            <Text size="small" className="text-ui-fg-subtle">Order</Text>
            <a href={`/app/orders/${review.order_id}`} className="text-ui-fg-interactive text-sm">
              #{review.order_display_id ?? review.order_id}
            </a>
            <Text size="small" className="text-ui-fg-subtle">Variant</Text>
            <Text size="small">{review.variant_title ?? "-"}</Text>
            <Text size="small" className="text-ui-fg-subtle">Sent</Text>
            <Text size="small">
              {day(review.submitted_at)}
              {review.edited_at ? `, edited ${day(review.edited_at)}` : ""} ({review.source === "link" ? "review link" : "order page"})
            </Text>
            {review.rejection_reason && (
              <>
                <Text size="small" className="text-ui-fg-subtle">Rejected for</Text>
                <Text size="small">
                  {review.rejection_reason}: {review.moderation_note}
                </Text>
              </>
            )}
          </div>
          {(review.flags?.signals ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {(review.flags?.signals ?? []).map((flag) => (
                <Badge key={flag} color="red" size="2xsmall">
                  {FLAG_TEXT[flag] ?? flag}
                </Badge>
              ))}
            </div>
          )}
        </Drawer.Body>
        <Drawer.Footer>
          {review.status !== "rejected" && (
            <Button variant="secondary" onClick={onReject}>
              Reject
            </Button>
          )}
          {review.status !== "approved" && (
            <Button onClick={() => approve.mutate()} isLoading={approve.isPending}>
              Publish
            </Button>
          )}
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}

const ReviewsPage = () => {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>("pending")
  const [rating, setRating] = useState("all")
  const [flagged, setFlagged] = useState(false)
  const [search, setSearch] = useState("")
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [open, setOpen] = useState<Review | null>(null)
  const [rejecting, setRejecting] = useState<Review[] | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ["product-reviews", status, rating, flagged, search, offset],
    queryFn: () =>
      sdk.client.fetch<ListResponse>("/admin/product-reviews", {
        query: {
          status,
          limit: PAGE,
          offset,
          ...(rating !== "all" ? { rating } : {}),
          ...(flagged ? { flagged: "true" } : {}),
          ...(search.trim() ? { q: search.trim() } : {}),
        },
      }),
  })

  const approve = useMutation({
    mutationFn: (ids: string[]) => sdk.client.fetch("/admin/product-reviews/moderate", { method: "POST", body: { ids, action: "approve" } }),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: ["product-reviews"] })
      setSelected([])
      toast.success(ids.length === 1 ? "Review published" : `${ids.length} reviews published`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const reviews = data?.reviews ?? []
  const allSelected = reviews.length > 0 && reviews.every((r) => selected.includes(r.id))
  const toggle = (id: string) => setSelected((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]))
  const pickTab = (value: Status) => {
    setStatus(value)
    setOffset(0)
    setSelected([])
  }

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="divide-y p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <Heading>Reviews</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Every review is from a delivered order. Publish honest reviews, good or bad; reject only what breaks the policy.
            </Text>
          </div>
          <div className="flex gap-x-2">
            {TABS.map((tab) => (
              <Button key={tab.value} size="small" variant={status === tab.value ? "primary" : "secondary"} onClick={() => pickTab(tab.value)}>
                {tab.label}
                {data?.counts ? ` (${data.counts[tab.value]})` : ""}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 px-6 py-3">
          <Input
            size="small"
            type="search"
            placeholder="Search text, name, email or product"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setOffset(0)
              setSelected([])
            }}
            className="w-72"
          />
          <Select
            size="small"
            value={rating}
            onValueChange={(value) => {
              setRating(value)
              setOffset(0)
              setSelected([])
            }}
          >
            <Select.Trigger className="w-36">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all">Any rating</Select.Item>
              {[5, 4, 3, 2, 1].map((n) => (
                <Select.Item key={n} value={String(n)}>
                  {n} star{n > 1 ? "s" : ""}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          <div className="flex items-center gap-x-2">
            <Checkbox
              id="flagged"
              checked={flagged}
              onCheckedChange={(value) => {
                setFlagged(value === true)
                setOffset(0)
                // What is ticked must always be what is shown, so a bulk action never reaches a hidden review.
                setSelected([])
              }}
            />
            <Label htmlFor="flagged" size="small">
              Flagged only
            </Label>
          </div>
          {selected.length > 0 && (
            <div className="ml-auto flex gap-x-2">
              {status !== "approved" && (
                <Button size="small" onClick={() => approve.mutate(selected)} isLoading={approve.isPending}>
                  Publish {selected.length}
                </Button>
              )}
              {status !== "rejected" && (
                <Button size="small" variant="secondary" onClick={() => setRejecting(reviews.filter((r) => selected.includes(r.id)))}>
                  Reject {selected.length}
                </Button>
              )}
            </div>
          )}
        </div>

        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell className="w-10">
                <Checkbox
                  aria-label="Select all"
                  checked={allSelected}
                  onCheckedChange={(value) => setSelected(value === true ? reviews.map((r) => r.id) : [])}
                />
              </Table.HeaderCell>
              <Table.HeaderCell>Rating</Table.HeaderCell>
              <Table.HeaderCell>Review</Table.HeaderCell>
              <Table.HeaderCell>Product</Table.HeaderCell>
              <Table.HeaderCell>Customer and order</Table.HeaderCell>
              <Table.HeaderCell>Sent</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Actions</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {reviews.map((review) => (
              <Table.Row key={review.id} className="cursor-pointer" onClick={() => setOpen(review)}>
                <Table.Cell onClick={(e) => e.stopPropagation()}>
                  <Checkbox aria-label={`Select review by ${review.display_name}`} checked={selected.includes(review.id)} onCheckedChange={() => toggle(review.id)} />
                </Table.Cell>
                <Table.Cell>
                  <Text size="small" className="text-ui-tag-orange-icon whitespace-nowrap tracking-wide">
                    {stars(review.rating)}
                  </Text>
                </Table.Cell>
                <Table.Cell className="max-w-md">
                  <Text size="small" weight="plus" className="truncate">
                    {review.title ?? review.body.slice(0, 60)}
                  </Text>
                  <Text size="small" className="text-ui-fg-subtle line-clamp-2 whitespace-normal">
                    {review.body}
                  </Text>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {review.verified_purchase && (
                      <Badge color="blue" size="2xsmall">
                        Verified
                      </Badge>
                    )}
                    {review.photos.length > 0 && (
                      <Badge color="purple" size="2xsmall">
                        {review.photos.length} photo{review.photos.length > 1 ? "s" : ""}
                      </Badge>
                    )}
                    {review.edited_at && (
                      <Badge color="grey" size="2xsmall">
                        Edited
                      </Badge>
                    )}
                    {(review.flags?.signals ?? []).map((flag) => (
                      <Badge key={flag} color="red" size="2xsmall">
                        {FLAG_TEXT[flag] ?? flag}
                      </Badge>
                    ))}
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <Text size="small">{review.product_title ?? review.product_id}</Text>
                  {review.variant_title && (
                    <Text size="small" className="text-ui-fg-subtle">
                      {review.variant_title}
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <Text size="small">{review.display_name}</Text>
                  <Text size="small" className="text-ui-fg-subtle">
                    {review.customer_email ?? ""}
                  </Text>
                  <a href={`/app/orders/${review.order_id}`} onClick={(e) => e.stopPropagation()} className="text-ui-fg-interactive text-xs">
                    Order #{review.order_display_id ?? "?"}
                  </a>
                </Table.Cell>
                <Table.Cell>
                  <Text size="small" className="whitespace-nowrap">
                    {day(review.submitted_at)}
                  </Text>
                </Table.Cell>
                <Table.Cell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-x-2">
                    {review.status !== "approved" && (
                      <Button size="small" onClick={() => approve.mutate([review.id])}>
                        Publish
                      </Button>
                    )}
                    {review.status !== "rejected" && (
                      <Button size="small" variant="secondary" onClick={() => setRejecting([review])}>
                        Reject
                      </Button>
                    )}
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        {!isLoading && reviews.length === 0 && (
          <div className="px-6 py-10 text-center">
            <Text className="text-ui-fg-subtle">No reviews here.</Text>
          </div>
        )}
        <div className="flex items-center justify-between px-6 py-3">
          <Text size="small" className="text-ui-fg-subtle">
            {data ? `${data.count === 0 ? 0 : offset + 1}–${Math.min(offset + PAGE, data.count)} of ${data.count}` : ""}
          </Text>
          <div className="flex gap-x-2">
            <Button size="small" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </Button>
            <Button size="small" variant="secondary" disabled={!data || offset + PAGE >= data.count} onClick={() => setOffset(offset + PAGE)}>
              Next
            </Button>
          </div>
        </div>
      </Container>

      {open && (
        <ReviewDrawer
          review={open}
          onClose={() => setOpen(null)}
          onReject={() => {
            setRejecting([open])
            setOpen(null)
          }}
        />
      )}
      {rejecting && data && (
        <RejectModal
          ids={rejecting.map((r) => r.id)}
          reasons={data.rejection_reasons}
          lowRating={rejecting.some((r) => r.rating <= 2)}
          onClose={() => {
            setRejecting(null)
            setSelected([])
          }}
        />
      )}
    </div>
  )
}

export const config = defineRouteConfig({
  label: "Reviews",
  icon: Star,
})

export default ReviewsPage
