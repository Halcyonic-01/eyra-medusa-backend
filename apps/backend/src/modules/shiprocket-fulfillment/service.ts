import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"

type ShiprocketOptions = {
  apiToken?: string
  pickupPincode?: string
  /** Flat rupee amount used when Shiprocket isn't configured or its API is unreachable. */
  fallbackRate: number
}

type CartItemForFulfillment = {
  quantity: unknown
  variant?: { weight?: number | null } | null
}

type CalculatePriceContext = {
  shipping_address?: { postal_code?: string | null } | null
  items?: readonly CartItemForFulfillment[]
}

type CalculatedShippingOptionPrice = {
  calculated_amount: number
  is_calculated_price_tax_inclusive: boolean
}

interface ShiprocketRate {
  rate: number
}

interface ShiprocketServiceabilityResponse {
  data?: {
    available_courier_companies?: ShiprocketRate[]
  }
}

/**
 * Fulfillment provider that prices shipping using Shiprocket's live courier
 * serviceability rates instead of a static flat amount.
 *
 * Falls back to a fixed rate whenever Shiprocket isn't configured or the API
 * call fails — a checkout should never hard-block on a shipping-rate lookup.
 */
class ShiprocketFulfillmentService extends AbstractFulfillmentProviderService {
  static identifier = "shiprocket"

  protected options_: ShiprocketOptions

  constructor(_container: unknown, options: ShiprocketOptions) {
    super()
    this.options_ = options
  }

  async getFulfillmentOptions() {
    return [{ id: "shiprocket-standard" }]
  }

  async canCalculate(): Promise<boolean> {
    return true
  }

  async validateOption(): Promise<boolean> {
    return true
  }

  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return data
  }

  async calculatePrice(
    _optionData: Record<string, unknown>,
    _data: Record<string, unknown>,
    context: CalculatePriceContext
  ): Promise<CalculatedShippingOptionPrice> {
    const fallback: CalculatedShippingOptionPrice = {
      calculated_amount: this.options_.fallbackRate,
      is_calculated_price_tax_inclusive: false,
    }

    const deliveryPincode = context.shipping_address?.postal_code
    const { apiToken, pickupPincode } = this.options_
    if (!deliveryPincode || !apiToken || !pickupPincode) {
      return fallback
    }

    const totalWeightG = (context.items ?? []).reduce((sum, item) => {
      const weight = item.variant?.weight ?? 0
      const quantity = Number(item.quantity) || 0
      return sum + weight * quantity
    }, 0)
    // Shiprocket's minimum chargeable slab.
    const weightKg = Math.max(totalWeightG / 1000, 0.5)

    try {
      const url = new URL(
        "https://apiv2.shiprocket.in/v1/external/courier/serviceability/"
      )
      url.searchParams.set("pickup_postcode", pickupPincode)
      url.searchParams.set("delivery_postcode", String(deliveryPincode))
      url.searchParams.set("weight", weightKg.toFixed(2))
      url.searchParams.set("cod", "0")

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiToken}` },
      })
      if (!res.ok) return fallback

      const body = (await res.json()) as ShiprocketServiceabilityResponse
      const rates = body.data?.available_courier_companies ?? []
      if (rates.length === 0) return fallback

      const cheapest = Math.min(...rates.map((c) => c.rate))
      if (!isFinite(cheapest)) return fallback

      return { calculated_amount: Math.round(cheapest), is_calculated_price_tax_inclusive: false }
    } catch {
      return fallback
    }
  }

  async createFulfillment() {
    return { data: {}, labels: [] }
  }

  async cancelFulfillment() {
    return {}
  }

  async createReturnFulfillment() {
    return { data: {}, labels: [] }
  }
}

export default ShiprocketFulfillmentService
