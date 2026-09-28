export type MonitorLoop = { tick(now?: number): Promise<unknown> }
export class MonitorScheduler {
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private lastError?: string
  private inFlight?: Promise<unknown>
  private startedAt?: number
  private lastCompletedTickAt?: number
  constructor(
    private readonly monitor: MonitorLoop,
    private readonly intervalMs = 1000,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}
  start() {
    if (this.timer) return
    this.running = true
    this.startedAt = this.now()
    this.lastCompletedTickAt = undefined
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.intervalMs)
    void this.runOnce()
  }
  async runOnce(now = Date.now()) {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.monitor
      .tick(now)
      .then((value) => {
        this.lastError = undefined
        return value
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : 'MONITOR_FAILED'
        this.onError(error)
        return []
      })
    try {
      return await this.inFlight
    } finally {
      this.lastCompletedTickAt = this.now()
      this.inFlight = undefined
    }
  }
  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.running = false
    await this.inFlight
  }
  health() {
    const last = this.lastCompletedTickAt ?? this.startedAt
    return {
      running: this.running,
      lastError: this.lastError,
      lastTickAgeMs: last === undefined ? null : Math.max(0, this.now() - last),
    }
  }
}
