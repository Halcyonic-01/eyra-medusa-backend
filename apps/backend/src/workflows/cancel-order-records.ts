import {
  createWorkflow,
  parallelize,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import { OrderWorkflowEvents, PaymentCollectionStatus } from "@medusajs/framework/utils"
import {
  cancelOrdersStep,
  cancelPaymentStep,
  deleteReservationsByLineItemsStep,
  emitEventStep,
  updatePaymentCollectionStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"

export type CancelOrderRecordsInput = {
  order_id: string
}

type OrderForCancel = {
  id: string
  items?: { id: string }[]
  payment_collections?: {
    id: string
    payments?: { id: string; captures?: { id: string }[] }[]
  }[]
}

/**
 * Cancels the order itself: releases its stock, voids payments that were never
 * captured, closes its payment collections, marks it cancelled and announces it.
 *
 * This is Medusa's own cancel without its last habit of refunding every
 * captured payment in full, because here the refund is decided separately.
 */
export const cancelOrderRecordsWorkflow = createWorkflow(
  "cancel-order-records",
  function (input: CancelOrderRecordsInput) {
    const { data: orders } = useQueryGraphStep({
      entity: "order",
      fields: [
        "id",
        "items.id",
        "payment_collections.id",
        "payment_collections.payments.id",
        "payment_collections.payments.captures.id",
      ],
      filters: { id: input.order_id },
      options: { throwIfKeyNotFound: true },
    })

    const parts = transform({ orders }, (data) => {
      const order = data.orders[0] as unknown as OrderForCancel
      const payments = (order.payment_collections ?? []).flatMap((collection) => collection.payments ?? [])
      return {
        lineItemIds: (order.items ?? []).map((item) => item.id),
        uncapturedPaymentIds: payments
          .filter((payment) => (payment.captures ?? []).length === 0)
          .map((payment) => payment.id),
        collectionIds: (order.payment_collections ?? []).map((collection) => collection.id),
      }
    })

    parallelize(
      deleteReservationsByLineItemsStep(
        transform({ parts }, (data) => data.parts.lineItemIds)
      ),
      cancelPaymentStep(
        transform({ parts }, (data) => ({ paymentIds: data.parts.uncapturedPaymentIds }))
      )
    )

    when("has-payment-collections", parts, (data) => data.collectionIds.length > 0).then(() => {
      updatePaymentCollectionStep(
        transform({ parts }, (data) => ({
          selector: { id: data.parts.collectionIds },
          update: { status: PaymentCollectionStatus.CANCELED },
        }))
      )
    })

    cancelOrdersStep(transform({ input }, (data) => ({ orderIds: [data.input.order_id] })))

    emitEventStep({
      eventName: OrderWorkflowEvents.CANCELED,
      data: transform({ input }, (data) => ({ id: data.input.order_id })),
    })

    return new WorkflowResponse(transform({ input }, (data) => ({ order_id: data.input.order_id })))
  }
)
