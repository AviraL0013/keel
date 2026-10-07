export type Side = 'BUY' | 'SELL'
export type SimOrder = { id: string; side: Side; price: number; size: number; postOnly: boolean; ioc?: boolean }
export type SimOrderState = SimOrder & {
  status: 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELED' | 'REJECTED'
  filledSize: number
  remainingSize: number
}
export type SimFill = { id: string; size: number; price: number }

/** Deterministic local venue. A quote at the touch does not cross. */
export class FakeMatchingEngine {
  private readonly orders = new Map<string, SimOrderState>()
  constructor(
    private bid: number,
    private ask: number,
    private bidSize = Infinity,
    private askSize = Infinity,
  ) {
    if (!(bid > 0 && ask > bid && bidSize >= 0 && askSize >= 0)) throw new Error('SIM_BOOK_INVALID')
  }

  post(order: SimOrder): SimOrderState {
    if (this.orders.has(order.id)) return { ...this.orders.get(order.id)! }
    if (
      !order.id ||
      !Number.isFinite(order.price) ||
      order.price <= 0 ||
      !Number.isFinite(order.size) ||
      order.size <= 0
    )
      throw new Error('SIM_ORDER_INVALID')
    const crosses = order.side === 'BUY' ? order.price >= this.ask : order.price <= this.bid
    const state: SimOrderState = { ...order, status: 'OPEN', filledSize: 0, remainingSize: order.size }
    if (order.postOnly && (crosses || order.ioc)) return { ...state, status: 'REJECTED' }
    if (order.ioc) {
      const available = order.side === 'BUY' ? this.askSize : this.bidSize
      const filledSize = crosses ? Math.min(order.size, available) : 0
      if (order.side === 'BUY') this.askSize -= filledSize
      else this.bidSize -= filledSize
      return {
        ...state,
        status: filledSize === order.size ? 'FILLED' : filledSize > 0 ? 'PARTIAL' : 'CANCELED',
        filledSize,
        remainingSize: 0,
      }
    }
    this.orders.set(order.id, state)
    return { ...state }
  }

  trade(aggressor: Side, price: number, size: number): SimFill[] {
    if (!(Number.isFinite(price) && price > 0 && Number.isFinite(size) && size > 0))
      throw new Error('SIM_TRADE_INVALID')
    const fills: SimFill[] = []
    let left = size
    for (const order of this.orders.values()) {
      if (left <= 0) break
      if (order.side === aggressor || (aggressor === 'SELL' ? price > order.price : price < order.price)) continue
      const matched = Math.min(left, order.remainingSize)
      order.filledSize += matched
      order.remainingSize -= matched
      order.status = order.remainingSize > 0 ? 'PARTIAL' : 'FILLED'
      fills.push({ id: order.id, size: matched, price: order.price })
      left -= matched
      if (order.status === 'FILLED') this.orders.delete(order.id)
    }
    return fills
  }

  cancel(id: string): SimOrderState {
    const order = this.orders.get(id)
    if (!order)
      return {
        id,
        side: 'BUY',
        price: 0,
        size: 0,
        postOnly: false,
        status: 'REJECTED',
        filledSize: 0,
        remainingSize: 0,
      }
    this.orders.delete(id)
    return { ...order, status: 'CANCELED', remainingSize: 0 }
  }

  change(id: string, price: number, size: number): SimOrderState {
    const order = this.orders.get(id)
    if (!order || !Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= order.filledSize)
      return { id, side: 'BUY', price, size, postOnly: false, status: 'REJECTED', filledSize: 0, remainingSize: 0 }
    const crosses = order.side === 'BUY' ? price >= this.ask : price <= this.bid
    if (order.postOnly && crosses) return { ...order, status: 'REJECTED' }
    order.price = price
    order.size = size
    order.remainingSize = size - order.filledSize
    return { ...order }
  }

  openOrders(): SimOrderState[] {
    return [...this.orders.values()].map((order) => ({ ...order }))
  }

  snapshot(bid: number, ask: number, bidSize = Infinity, askSize = Infinity): void {
    if (!(bid > 0 && ask > bid && bidSize >= 0 && askSize >= 0)) throw new Error('SIM_BOOK_INVALID')
    this.bid = bid
    this.ask = ask
    this.bidSize = bidSize
    this.askSize = askSize
  }
}
