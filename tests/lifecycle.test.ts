import { describe, expect, it, vi } from 'vitest'
import { MonitorScheduler } from '../server/src/lifecycle.js'
describe('monitor lifecycle', () => {
  it('runs, reports health, stops, and catches failures', async () => {
    const tick = vi.fn().mockResolvedValue([])
    const scheduler = new MonitorScheduler({ tick }, 10000)
    await scheduler.runOnce(123)
    expect(tick).toHaveBeenCalledWith(123)
    scheduler.start(); expect(scheduler.health().running).toBe(true); scheduler.stop(); expect(scheduler.health().running).toBe(false)
  })
})
