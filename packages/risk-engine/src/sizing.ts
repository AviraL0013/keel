import Decimal from 'decimal.js'
import type { Book, Position, Reserve, RiskFeatures } from '../../domain/src/index.js'

/** A proposal, not a promise of the venue's resulting liquidation price. */
export function sizeDefense(book: Book, position: Position, reserve: Reserve, features: RiskFeatures, mark: number, mode: 'AUTOMATED' | 'MANUAL' = 'AUTOMATED'): number {
  if (!features.fresh || book.stance !== 'DEFEND' || (mode === 'AUTOMATED' && !book.automationEnabled)) return 0
  const gap = new Decimal(book.liquidationFloor).minus(features.liquidationDistance)
  if (gap.lte(0) || !Number.isFinite(mark) || mark <= 0 || position.margin < 0) return 0
  // Prefer a venue-verified sensitivity. Otherwise use a bounded linear isolated
  // margin estimate. Execution must reconcile the actual improvement afterward.
  const sensitivity = position.collateralPerDistancePoint ?? new Decimal(position.size).abs().mul(mark).div(100).toNumber()
  if (!Number.isFinite(sensitivity) || sensitivity <= 0) return 0
  const required = gap.mul(sensitivity).toDecimalPlaces(6, Decimal.ROUND_CEIL)
  const ceiling = Decimal.min(reserve.available, features.reserveHeadroom, new Decimal(book.defenseCap))
  return required.gt(0) && required.lte(ceiling) ? required.toNumber() : 0
}

export type DefenseObservation = { liquidationDistance: number; funding: number; depth: number; volatility: number; timestamp: number }
export function measureDefense(before: DefenseObservation, after: DefenseObservation, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0 || after.timestamp < before.timestamp || ![...Object.values(before), ...Object.values(after)].every(Number.isFinite)) throw new Error('INVALID_DEFENSE_MEASUREMENT')
  const improvement = new Decimal(after.liquidationDistance).minus(before.liquidationDistance)
  return { amount, before, after, improvement: improvement.toNumber(), efficiency: improvement.div(amount).toNumber(), elapsedMs: after.timestamp - before.timestamp, fundingDelta: after.funding - before.funding, depthDelta: after.depth - before.depth, volatilityDelta: after.volatility - before.volatility }
}
