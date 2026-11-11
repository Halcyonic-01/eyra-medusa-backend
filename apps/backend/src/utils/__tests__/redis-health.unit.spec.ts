import { RedisHealth } from "../redis-health"

function rig() {
  let clock = 0
  let answer: "ok" | "fail" | "hang" = "ok"
  const events: string[] = []
  const health = new RedisHealth(
    () => (answer === "ok" ? Promise.resolve("PONG") : answer === "fail" ? Promise.reject(new Error("down")) : new Promise(() => undefined)),
    (event) => events.push(event),
    () => clock,
    50,
    30000
  )
  return { health, events, set: (a: typeof answer) => (answer = a), tick: (ms: number) => (clock += ms) }
}

describe("RedisHealth", () => {
  it("starts unknown and goes up on an answer", async () => {
    const { health } = rig()
    expect(health.state).toBe("unknown")
    expect(await health.check()).toBe("up")
  })

  it("is down at once when Redis refuses or does not answer in time", async () => {
    const r = rig()
    r.set("fail")
    expect(await r.health.check()).toBe("down")
    r.set("hang")
    expect(await r.health.check()).toBe("down")
  })

  it("alerts once after 30 s down, and once on recovery", async () => {
    const r = rig()
    await r.health.check()
    r.set("fail")
    await r.health.check()
    r.tick(10000)
    await r.health.check()
    expect(r.events).toEqual([])
    r.tick(25000)
    await r.health.check()
    await r.health.check()
    expect(r.events).toEqual(["down"])
    r.set("ok")
    await r.health.check()
    await r.health.check()
    expect(r.events).toEqual(["down", "recovered"])
  })

  it("says nothing about a short blip", async () => {
    const r = rig()
    r.set("fail")
    await r.health.check()
    r.tick(5000)
    r.set("ok")
    await r.health.check()
    expect(r.events).toEqual([])
  })
})
