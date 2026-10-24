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
  /** When the fallback was last explained, so a busy checkout does not flood the log. */
  protected lastFallbackLog_ = 0

  /** Says why the fixed estimate was used, at most once every ten minutes. */
  protected explainFallback_(reason: string) {
    if (Date.now() - this.lastFallbackLog_ < 10 * 60 * 1000) return
    this.lastFallbackLog_ = Date.now()
    console.warn(`[shiprocket] using the fixed shipping estimate: ${reason}`)
  }

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
      this.explainFallback_(
        !apiToken
          ? "SHIPROCKET_API_TOKEN is not set"
          : !pickupPincode
          ? "SHIPROCKET_PICKUP_PINCODE is not set"
          : "the cart has no delivery pincode yet"
      )
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
      if (!res.ok) {
        this.explainFallback_(
          res.status === 401 ? "Shiprocket rejected the token (expired or wrong)" : `Shiprocket answered ${res.status}`
        )
        return fallback
      }

      const body = (await res.json()) as ShiprocketServiceabilityResponse
      const rates = body.data?.available_courier_companies ?? []
      if (rates.length === 0) {
        this.explainFallback_("Shiprocket has no courier for that pincode and weight")
        return fallback
      }

      const cheapest = Math.min(...rates.map((c) => c.rate))
      if (!isFinite(cheapest)) return fallback

      return { calculated_amount: Math.round(cheapest), is_calculated_price_tax_inclusive: false }
    } catch (error) {
      this.explainFallback_(`the Shiprocket request failed (${(error as Error).message})`)
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
