import { formatUnits, type Address } from 'viem'
import type { Reserve } from '../../domain/src/index.js'
import type { ChainAdapter, ChainEnvironment } from '../../chain/src/index.js'
export type AusdBalance = { token: Address; chainId: number; raw: bigint; decimals: number; symbol: string }
export class AusdAdapter {
  constructor(private readonly chain: ChainAdapter) {}
  async walletBalance(address: Address): Promise<AusdBalance> { const value = await this.chain.getAusdBalance(address); return { token: value.address, chainId: value.chainId, raw: value.balance, decimals: value.decimals, symbol: value.symbol } }
  reconcileReserve(reserve: Reserve, walletRaw: bigint, decimals = 6) {
    if (decimals < 0 || decimals > 18 || !Number.isInteger(decimals)) throw new Error('INVALID_TOKEN_DECIMALS')
    const total = BigInt(Math.round((reserve.available + reserve.reserved + reserve.deployed) * 10 ** decimals))
    return { ...reserve, externalWalletRaw: walletRaw.toString(), externalWalletBalance: formatUnits(walletRaw, decimals), reconciled: walletRaw === total }
  }
}
export function ausdEnvironment(environment: ChainEnvironment) { return environment }

