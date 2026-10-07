import type { Pool } from 'pg'
import { strategyEquity } from '../../../../packages/strategies/src/index.js'
import { StrategyStore } from './store.js'

export type StrategyTelegramCommand = 'status' | 'pnl' | 'pause' | 'resume' | 'killswitch'
export class StrategyTelegramCommands {
  private readonly store: StrategyStore
  constructor(
    pool: Pool,
    environment: 'testnet' | 'mainnet',
    private readonly reply: (chatId: string, text: string) => Promise<void>,
  ) {
    this.store = new StrategyStore(pool, environment)
  }

  async execute(userId: string, command: StrategyTelegramCommand): Promise<string> {
    if (command === 'killswitch') {
      await this.store.kill(userId)
      return 'Eyeler Autopilot: kill switch ON. Strategies halted. Reset in app.'
    }
    if (command === 'pause') {
      const count = await this.store.pauseAll(userId)
      return `Eyeler Autopilot: ${count} paper strategies paused.`
    }
    if (command === 'resume') {
      if (await this.store.killed(userId)) return 'Eyeler Autopilot: kill switch ON. Reset in app before resuming.'
      const count = await this.store.resumeAll(userId)
      return `Eyeler Autopilot: ${count} paper strategies resumed.`
    }
    const rows = await this.store.list(userId)
    if (command === 'status') {
      const running = rows.filter((row) => row.status === 'RUNNING').length
      const halted = rows.filter((row) => row.status === 'HALTED').length
      return `Eyeler Autopilot: ${running} running, ${halted} halted, ${rows.length} total. Kill switch ${(await this.store.killed(userId)) ? 'ON' : 'OFF'}.`
    }
    const observed = rows.filter((row) => row.mode === 'PAPER' && row.state.lastMark !== undefined)
    const pnl = observed.reduce(
      (sum, row) => sum + strategyEquity(row.state, row.state.lastMark!) - row.state.capital,
      0,
    )
    return `Eyeler Autopilot: simulated PnL ${pnl.toFixed(4)} across ${observed.length} observed paper strategies.`
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.reply(chatId, text)
  }
}

export function telegramCommandSender(token: string, fetcher: typeof fetch = fetch) {
  return async (chatId: string, text: string) => {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    if (!response.ok) throw new Error(`TELEGRAM_COMMAND_DELIVERY_${response.status}`)
  }
}
