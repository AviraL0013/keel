import type { Book, NormalizedTelemetry, Position, Reserve, RiskState } from '../../domain/src/index.js'
import { evaluate } from './index.js'
export type ReplayFrame = { at: number; telemetry: NormalizedTelemetry; label?: string }
export type ReplayResult = { at: number; label?: string; state: RiskState; action: string; codes: string[]; reasons: string[] }
export function replay(book: Book, position: Position, reserve: Reserve, frames: ReplayFrame[], priorDefenseEfficiency = Infinity): ReplayResult[] { return frames.map(frame => { const decision = evaluate(book, { ...position, markPrice: frame.telemetry.mark }, reserve, frame.telemetry, priorDefenseEfficiency, frame.at); return { at: frame.at, label: frame.label, state: decision.state, action: decision.action, codes: decision.reasonCodes, reasons: decision.humanReadableReasons } }) }
export const replayScenarios = { healthy: 'healthy', floorBreach: 'floor-breach', lowReserve: 'low-reserve', depthCollapse: 'depth-collapse', defenseRefusal: 'defense-refusal', stale: 'stale', timeLimit: 'time-limit', killStance: 'kill-stance', shortPosition: 'short-position', disconnect: 'disconnect' } as const
