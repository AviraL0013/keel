import { evaluate } from '../../packages/risk-engine/src/index.js'
import type { Book, Decision, NormalizedTelemetry, Position, Reserve } from '../../packages/domain/src/index.js'
export type MonitorRepository = { getArmedBooks(): Promise<Array<{ book: Book; position: Position; reserve: Reserve; telemetry: NormalizedTelemetry; priorDefenseEfficiency: number }>>; saveDecision(decision: Decision): Promise<void> }
export class BookMonitor {
  private readonly fingerprints = new Map<string, string>()
  constructor(private readonly repository: MonitorRepository) {}
  async tick(now = Date.now()) { const decisions: Decision[] = []; for (const context of await this.repository.getArmedBooks()) { const decision = evaluate(context.book, context.position, context.reserve, context.telemetry, context.priorDefenseEfficiency, now); const fingerprint = JSON.stringify([decision.state, decision.action, decision.amount, decision.reasonCodes]); if (this.fingerprints.get(context.book.id) === fingerprint) continue; this.fingerprints.set(context.book.id, fingerprint); await this.repository.saveDecision(decision); decisions.push(decision) } return decisions }
}
