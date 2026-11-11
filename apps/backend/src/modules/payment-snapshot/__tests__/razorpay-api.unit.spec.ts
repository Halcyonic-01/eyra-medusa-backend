import { fetchRazorpayOrderPayments, RazorpayUnavailableError } from "../razorpay-api"

const json = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response

describe("fetchRazorpayOrderPayments", () => {
  const env = { ...process.env }
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    process.env.RAZORPAY_ID = "rzp_test_unit"
    process.env.RAZORPAY_SECRET = "unit-secret"
    delete process.env.RAZORPAY_TEST_KEY_ID
    delete process.env.RAZORPAY_TEST_KEY_SECRET
    fetchSpy = jest.spyOn(global, "fetch")
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    process.env = { ...env }
  })

  it("reads the order and its payments with the server's keys", async () => {
    fetchSpy
      .mockResolvedValueOnce(json(200, { id: "order_1", amount: 100000, currency: "INR", status: "paid" }))
      .mockResolvedValueOnce(json(200, { items: [{ id: "pay_1", order_id: "order_1", amount: 100000, currency: "INR", status: "captured" }] }))

    const result = await fetchRazorpayOrderPayments("order_1")

    expect(result.order?.id).toBe("order_1")
    expect(result.payments).toHaveLength(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://api.razorpay.com/v1/orders/order_1")
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("rzp_test_unit:unit-secret").toString("base64")}`,
    })
    expect(fetchSpy.mock.calls[1][0]).toBe("https://api.razorpay.com/v1/orders/order_1/payments")
  })

  it("answers a missing order with null, not an error", async () => {
    fetchSpy.mockResolvedValueOnce(json(404, { error: {} }))
    await expect(fetchRazorpayOrderPayments("order_x")).resolves.toEqual({ order: null, payments: [] })
  })

  it("treats a timeout or 5xx as unknown, never as unpaid", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("timeout"))
    await expect(fetchRazorpayOrderPayments("order_1")).rejects.toBeInstanceOf(RazorpayUnavailableError)

    fetchSpy.mockResolvedValueOnce(json(502, {}))
    await expect(fetchRazorpayOrderPayments("order_1")).rejects.toBeInstanceOf(RazorpayUnavailableError)
  })

  it("refuses to guess without keys", async () => {
    delete process.env.RAZORPAY_ID
    await expect(fetchRazorpayOrderPayments("order_1")).rejects.toBeInstanceOf(RazorpayUnavailableError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
