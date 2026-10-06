import { formatUnits, type Address } from 'viem'
import Decimal from 'decimal.js'
import type { Reserve } from '../../domain/src/index.js'
import type { ChainAdapter, ChainEnvironment } from '../../chain/src/index.js'
export type AusdBalance = {
  token: Address
  chainId: number
  raw: bigint
  decimals: number
  symbol: string
  blockNumber?: bigint
  observedAt?: number
}
export class AusdAdapter {
  constructor(private readonly chain: ChainAdapter) {}
  async walletBalance(address: Address): Promise<AusdBalance> {
    const value = await this.chain.getAusdBalance(address)
    if (
      value.chainId !== this.chain.config.chainId ||
      value.address.toLowerCase() !== this.chain.config.ausdToken.toLowerCase() ||
      value.decimals !== 6 ||
      typeof value.balance !== 'bigint' ||
      value.balance < 0n ||
      value.balance >= 1n << 256n
    )
      throw new Error('INVALID_TOKEN_SNAPSHOT')
    return {
      token: value.address,
      chainId: value.chainId,
      raw: value.balance,
      decimals: value.decimals,
      symbol: value.symbol,
      blockNumber: value.blockNumber,
      observedAt: value.observedAt,
    }
  }
  reconcileReserve(reserve: Reserve, walletRaw: bigint, decimals = 6) {
    if (decimals < 0 || decimals > 18 || !Number.isInteger(decimals)) throw new Error('INVALID_TOKEN_DECIMALS')
    const totalUnits = new Decimal(reserve.available)
      .plus(reserve.reserved)
      .plus(reserve.deployed)
      .mul(new Decimal(10).pow(decimals))
    if (!totalUnits.isInteger() || totalUnits.isNegative()) throw new Error('INVALID_AUSD_AMOUNT')
    const total = BigInt(totalUnits.toFixed(0))
    return {
      ...reserve,
      externalWalletRaw: walletRaw.toString(),
      externalWalletBalance: formatUnits(walletRaw, decimals),
      reconciled: walletRaw === total,
    }
  }
}
export function ausdEnvironment(environment: ChainEnvironment) {
  return environment
}
