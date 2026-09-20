export type MonitorLoop = { tick(now?: number): Promise<unknown> }
export class MonitorScheduler {
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private lastError?: string
  private inFlight?: Promise<unknown>
  constructor(private readonly monitor: MonitorLoop, private readonly intervalMs = 1000, private readonly onError: (error: unknown) => void = () => undefined) {}
  start() { if (this.timer) return; this.running = true; this.timer = setInterval(() => { void this.runOnce() }, this.intervalMs); void this.runOnce() }
  async runOnce(now = Date.now()) {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.monitor.tick(now).then(value => { this.lastError = undefined; return value }).catch(error => { this.lastError = error instanceof Error ? error.message : 'MONITOR_FAILED'; this.onError(error); return [] })
    try { return await this.inFlight } finally { this.inFlight = undefined }
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.running = false; await this.inFlight }
  health() { return { running: this.running, lastError: this.lastError } }
}
