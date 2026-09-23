import { sizeDefense } from './sizing.js'
export type { RiskState, BookStance as Stance } from '../../domain/src/index.js'
import { defaultFreshnessThresholds, type Book, type Decision, type NormalizedTelemetry, type Position, type Reserve, type RiskFeatures } from '../../domain/src/index.js'
import { applyBookPolicy } from './policy.js'
export type RiskConfig = { freshnessWindowMs: number; maxSpreadBps: number; minDepthNotional: number; maxFundingPressure: number; minDefenseEfficiency: number; minReserveAfterAction: number; maxVolatility: number }
export const defaultRiskConfig: RiskConfig = { freshnessWindowMs: defaultFreshnessThresholds.marketMs, maxSpreadBps: 40, minDepthNotional: 1000, maxFundingPressure: 0.0008, minDefenseEfficiency: 0.25, minReserveAfterAction: 0, maxVolatility: 0.1 }
export type { RiskFeatures }
export function liquidationDistance(position: Position, mark = position.markPrice): number { if (mark <= 0) return 0; return position.side === 'LONG' ? (mark - position.liquidationPrice) / mark * 100 : (position.liquidationPrice - mark) / mark * 100 }
type TelemetrySource = 'market' | 'position' | 'funding' | 'orderbook'
export function telemetryFreshnessFailures(telemetry: NormalizedTelemetry, position: Position, now = Date.now(), thresholdMs = defaultRiskConfig.freshnessWindowMs) {
  const observedAt = position.observedAt ?? position.timestamp
  const fallback = telemetry.timestamp
  const updatedAt: Record<TelemetrySource, number | undefined> = {
    market: telemetry.marketTimestamp ?? fallback,
    // Legacy/replay frames predate explicit position timestamps. Their
    // telemetry timestamp is the only observed-time evidence available.
    position: telemetry.positionTimestamp ?? observedAt ?? fallback,
    funding: telemetry.fundingTimestamp ?? fallback,
    orderbook: telemetry.orderbookTimestamp ?? fallback,
  }
  const explicit = telemetry.freshness
  const status = (source: TelemetrySource) => {
    const point = explicit?.[source]
    if (point) return point.status
    const at = updatedAt[source]
    if (!Number.isFinite(at) || (at ?? 0) <= 0) return 'UNKNOWN'
    return now - at! <= thresholdMs && now >= at! ? 'FRESH' : 'STALE'
  }
  const failed = (['market', 'position', 'funding', 'orderbook'] as const).filter(source => status(source) !== 'FRESH')
  const label = (source: TelemetrySource) => source === 'orderbook' ? 'Depth' : source[0].toUpperCase() + source.slice(1)
  if (!failed.length) return { codes: [] as string[], reasons: [] as string[], failed, updatedAt }
  const marketPosition = failed.filter(source => source === 'market' || source === 'position')
  if (marketPosition.length === 2 && failed.length === 2 && marketPosition.every(source => status(source) === 'STALE')) return { codes: ['BOTH_STALE'], reasons: ['Market and position telemetry are stale.'], failed, updatedAt }
  const codes = failed.map(source => `${source === 'orderbook' ? 'DEPTH' : source.toUpperCase()}_${status(source)}`)
  const reasons = failed.map(source => `${label(source)} telemetry is ${status(source) === 'UNKNOWN' ? 'unavailable' : 'stale'}.`)
  return { codes, reasons, failed, updatedAt }
}
export function deriveFeatures(book: Book, position: Position, reserve: Reserve, telemetry: NormalizedTelemetry, now = Date.now(), config = defaultRiskConfig, priorDefenseEfficiency = Infinity): RiskFeatures {
  const distance = position.side === undefined ? Math.abs(position.markPrice - position.liquidationPrice) / Math.max(position.markPrice, 1) * 100 : (position.side === 'LONG' ? (telemetry.mark - position.liquidationPrice) : (position.liquidationPrice - telemetry.mark)) / Math.max(telemetry.mark, 1) * 100
  const timeRemainingMs = Math.max(0, new Date(book.createdAt).getTime() + book.timeLimitMs - now)
  const fields = [telemetry.mark, telemetry.oracle, telemetry.bid, telemetry.ask, telemetry.timestamp, telemetry.freshnessMs, telemetry.depthNotional, telemetry.volatility, telemetry.spreadBps, telemetry.fundingRate, position.size, position.liquidationPrice, reserve.available, reserve.reserved, reserve.deployed, reserve.cap, book.defenseCap, book.liquidationFloor, book.timeLimitMs, Date.parse(book.createdAt)]
  const freshnessFailures = telemetryFreshnessFailures(telemetry, position, now, config.freshnessWindowMs)
  const fresh = telemetry.executionHealthy !== false && freshnessFailures.codes.length === 0 && position.liquidationPrice > 0 && fields.every(Number.isFinite) && telemetry.mark > 0 && telemetry.oracle > 0 && telemetry.bid > 0 && telemetry.ask >= telemetry.bid && telemetry.depthNotional >= 0 && telemetry.volatility >= 0 && position.size > 0 && position.side === book.side && reserve.available >= 0 && reserve.reserved >= 0 && reserve.deployed >= 0 && reserve.deployed + reserve.reserved <= reserve.cap && telemetry.timestamp <= now && now - telemetry.timestamp <= config.freshnessWindowMs && telemetry.freshnessMs >= 0 && telemetry.freshnessMs <= config.freshnessWindowMs
  const depthCoverage = telemetry.depthNotional / Math.max(Math.abs(position.size * telemetry.mark), config.minDepthNotional)
  const reserveHeadroom = Math.max(0, Math.min(reserve.available, book.defenseCap, reserve.cap - reserve.deployed - reserve.reserved))
  return { liquidationDistance: distance, fundingPressure: Math.max(0, telemetry.fundingRate * (position.side === 'LONG' ? 1 : -1)), spreadBps: telemetry.spreadBps, depthCoverage, volatility: telemetry.volatility, reserveHeadroom, capUtilization: reserve.cap <= 0 ? 1 : reserve.deployed / reserve.cap, timeRemainingMs, defenseEfficiency: priorDefenseEfficiency, fresh }
}
export function defenseAmount(features: RiskFeatures, position: Position, reserve: Reserve, book: Book, telemetry: NormalizedTelemetry, mode: 'AUTOMATED' | 'MANUAL' = 'AUTOMATED'): number { return sizeDefense(book, position, reserve, features, telemetry.mark, mode) }
export function classifyDecision(book: Book, features: RiskFeatures, amount: number, config = defaultRiskConfig): Omit<Decision, 'id' | 'bookId' | 'createdAt'> {
  const policy = applyBookPolicy(book, features, amount, features.reserveHeadroom); const reasons: string[] = [...policy.reasons]; const codes: string[] = [...policy.codes]
  if (!features.fresh) return { state: 'SAFE_MODE', action: 'SAFE_MODE', amount: 0, reasonCodes: ['STALE_STATE'], humanReadableReasons: ['Required market or position telemetry is stale.'] , riskFeatures: features }
  if (!book.automationEnabled || book.status === 'PAUSED' || book.status === 'CLOSED') return { state: 'HOLD', action: 'HOLD', amount: 0, reasonCodes: ['AUTOMATION_PAUSED'], humanReadableReasons: ['Automation is paused; no automated action is authorized.'], riskFeatures: features }
  if (features.timeRemainingMs <= 0) { return { state: 'EXIT', action: 'EXIT', amount: 0, reasonCodes: ['TIME_LIMIT'], humanReadableReasons: ['Book time limit reached; position must flatten.'], riskFeatures: features } }
  if (book.stance === 'KILL') return { state: 'EXIT', action: 'EXIT', amount: 0, reasonCodes: ['USER_KILL'], humanReadableReasons: ['Kill stance forbids further rescue.'], riskFeatures: features }
  const floorBreached = features.liquidationDistance < book.liquidationFloor
  if (floorBreached) { reasons.push('Liquidation distance crossed configured floor.'); codes.push('LIQ_FLOOR') }
  if (features.fundingPressure > config.maxFundingPressure) { reasons.push('Funding pressure is elevated.'); codes.push('FUNDING_PRESSURE') }
  if (features.volatility > config.maxVolatility) { reasons.push('Volatility exceeded the configured risk regime.'); codes.push('VOL_SPIKE') }
  if (features.spreadBps > config.maxSpreadBps || features.depthCoverage < 1) { reasons.push('Executable liquidity is deteriorating.'); codes.push('DEPTH_BAD') } else codes.push('DEPTH_OK')
  if (features.reserveHeadroom <= 0 || features.reserveHeadroom < amount) { reasons.push('Reserve headroom cannot fund another bounded action.'); codes.push('RESERVE_LOW') } else codes.push('RESERVE_OK')
  if (features.defenseEfficiency < config.minDefenseEfficiency) { reasons.push('Previous defense produced insufficient improvement.'); codes.push('DEFENSE_INEFFICIENT', 'DEFENSE_REFUSED') }
  if (!floorBreached && features.fundingPressure <= config.maxFundingPressure && features.depthCoverage >= 1 && features.spreadBps <= config.maxSpreadBps && features.volatility <= config.maxVolatility) return { state: 'HOLD', action: 'HOLD', amount: 0, reasonCodes: ['WITHIN_LIMITS'], humanReadableReasons: ['All Book constraints remain inside configured limits.'], riskFeatures: features }
  if (!policy.permitted) return { state: features.timeRemainingMs <= 0 || policy.codes.includes('USER_KILL') ? 'EXIT' : 'REDUCE', action: features.timeRemainingMs <= 0 || policy.codes.includes('USER_KILL') ? 'EXIT' : 'REDUCE', amount: 0, reasonCodes: codes, humanReadableReasons: reasons, riskFeatures: features }
  if (floorBreached && amount > 0 && book.stance === 'DEFEND' && features.fundingPressure <= config.maxFundingPressure && features.spreadBps <= config.maxSpreadBps && features.depthCoverage >= 1 && features.volatility <= config.maxVolatility && features.defenseEfficiency >= config.minDefenseEfficiency) return { state: 'DEFEND', action: 'DEFEND', amount, reasonCodes: codes, humanReadableReasons: reasons, riskFeatures: features }
  if (features.spreadBps > config.maxSpreadBps * 2 || features.depthCoverage < .5 || features.defenseEfficiency < config.minDefenseEfficiency || features.fundingPressure > config.maxFundingPressure * 2 || features.volatility > config.maxVolatility * 2) return { state: 'EXIT', action: 'EXIT', amount: 0, reasonCodes: codes, humanReadableReasons: reasons, riskFeatures: features }
  return { state: 'REDUCE', action: 'REDUCE', amount: 0, reasonCodes: codes, humanReadableReasons: reasons, riskFeatures: features }
}
export function evaluate(book: Book, position: Position, reserve: Reserve, telemetry: NormalizedTelemetry, priorDefenseEfficiency = Infinity, now = Date.now(), config = defaultRiskConfig): Decision { const features = deriveFeatures(book, position, reserve, telemetry, now, config, priorDefenseEfficiency); const amount = defenseAmount(features, position, reserve, book, telemetry); const result = classifyDecision(book, features, amount, config); const freshnessFailures = telemetryFreshnessFailures(telemetry, position, now, config.freshnessWindowMs); const reasoned = !features.fresh && freshnessFailures.codes.length ? { ...result, reasonCodes: freshnessFailures.codes, humanReadableReasons: freshnessFailures.reasons } : result; return { ...reasoned, id: `${book.id}:${now}:${reasoned.state}`, bookId: book.id, createdAt: new Date(now).toISOString() } }

export function evaluateManualAction(book: Book, position: Position, reserve: Reserve, telemetry: NormalizedTelemetry, requestedAction: 'DEFEND' | 'REDUCE', priorDefenseEfficiency = Infinity, now = Date.now(), config = defaultRiskConfig): Decision {
  const features = deriveFeatures(book, position, reserve, telemetry, now, config, priorDefenseEfficiency)
  const freshnessFailures = telemetryFreshnessFailures(telemetry, position, now, config.freshnessWindowMs)
  const amount = defenseAmount(features, position, reserve, book, telemetry, 'MANUAL')
  const decision = (state: Decision['state'], action: Decision['action'], reasonCodes: string[], reasons: string[], value = 0): Decision => ({ id: `${book.id}:${now}:${state}:MANUAL`, bookId: book.id, state, action, amount: value, reasonCodes, humanReadableReasons: reasons, riskFeatures: features, createdAt: new Date(now).toISOString() })
  if (!features.fresh) return decision('SAFE_MODE', 'SAFE_MODE', freshnessFailures.codes.length ? freshnessFailures.codes : ['TELEMETRY_INVALID'], freshnessFailures.reasons.length ? freshnessFailures.reasons : ['Required telemetry is invalid or cannot be trusted.'])
  if (position.status !== 'OPEN') return decision('SAFE_MODE', 'SAFE_MODE', ['POSITION_NOT_OPEN'], ['The bound position is no longer open.'])
  if (book.status !== 'ACTIVE') return decision('HOLD', 'HOLD', ['BOOK_NOT_ACTIVE'], ['Book is paused or closed; manual action is not permitted.'])
  if (book.stance === 'KILL') return decision('EXIT', 'EXIT', ['USER_KILL'], ['Kill switch prohibits further rescue.'])
  if (book.stance === 'HARVEST' && requestedAction === 'DEFEND') return decision('HOLD', 'HOLD', ['HARVEST_NO_RESCUE'], ['Harvest stance does not permit collateral rescue.'])
  if (requestedAction === 'DEFEND' && book.stance !== 'DEFEND') return decision('HOLD', 'HOLD', ['STANCE_DISALLOWS_DEFEND'], ['Book stance does not permit manual defense.'])
  if (features.timeRemainingMs <= 0) return decision('EXIT', 'EXIT', ['TIME_LIMIT'], ['Book time limit has expired.'])
  if (features.fundingPressure > config.maxFundingPressure) return decision('REDUCE', 'REDUCE', ['FUNDING_PRESSURE'], ['Funding pressure is too high for manual defense.'])
  if (features.volatility > config.maxVolatility) return decision('REDUCE', 'REDUCE', ['VOL_SPIKE'], ['Volatility is too high for manual defense.'])
  if (features.spreadBps > config.maxSpreadBps || features.depthCoverage < 1) return decision('REDUCE', 'REDUCE', ['DEPTH_BAD'], ['Executable liquidity is insufficient for manual defense.'])
  if (priorDefenseEfficiency < config.minDefenseEfficiency) return decision('REDUCE', 'REDUCE', ['DEFENSE_INEFFICIENT'], ['The previous defense did not improve liquidation distance enough.'])
  if (requestedAction === 'DEFEND') {
    if (amount <= 0 && features.liquidationDistance < book.liquidationFloor) return decision('REDUCE', 'REDUCE', ['CAP_EXCEEDED'], ['The required manual defense exceeds the available reserve or defense cap.'])
    if (amount <= 0) return decision('HOLD', 'HOLD', ['DEFENSE_NOT_REQUIRED'], ['Liquidation distance is above the configured floor; no bounded defense amount is required.'])
    if (amount > book.defenseCap || amount > reserve.available || amount > features.reserveHeadroom) return decision('REDUCE', 'REDUCE', ['CAP_EXCEEDED'], ['Manual defense exceeds the available reserve or defense cap.'])
    return decision('DEFEND', 'DEFEND', ['MANUAL_ACTION', 'LIQ_FLOOR', 'RESERVE_OK'], ['Manual defense is authorized within the configured safety limits.'], amount)
  }
  return decision('REDUCE', 'REDUCE', ['MANUAL_ACTION'], ['Manual reduction is authorized within the configured safety limits.'])
}

