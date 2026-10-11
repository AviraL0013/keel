/** One process-wide budget for the HyperSync token shared by rollups and wallet reads. */
export class HyperSyncRequestPacer {
  private nextAt = 0
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly intervalMs = 4_200,
    private readonly now: () => number = Date.now,
    private readonly pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  wait(): Promise<void> {
    const turn = this.tail.then(async () => {
      const delay = Math.max(0, this.nextAt - this.now())
      if (delay) await this.pause(delay)
      this.nextAt = this.now() + this.intervalMs
    })
    this.tail = turn.catch(() => undefined)
    return turn
  }

  cooldown(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.now() + ms)
  }
}

export const sharedHyperSyncPacer = new HyperSyncRequestPacer()
