import type { Address } from 'viem'
import { getAddress } from 'viem'
import type { CapitalAmount, CapitalSnapshot } from '../../../../packages/domain/src/index.js'
import { defaultFreshnessThresholds } from '../../../../packages/domain/src/index.js'
import { PerplAdapter, decodeAmount } from '../../../../packages/perpl/src/index.js'
import { AusdAdapter } from '../../../../packages/ausd/src/index.js'
import { ChainAdapter, chainConfigs } from '../../../../packages/chain/src/index.js'
import { perplNetworks } from '../../../../packages/perpl/src/index.js'
import { AgoraAdapter } from '../../../../packages/chain/src/agora.js'
import { publicAusdSupply } from '../agora/metrics.js'
import { reconcileBookCapital, type BookCapitalRow } from './reconciliation.js'
import { formatMoney, moneyMicros } from '../../../../packages/ausd/src/money.js'
import type { PostgresStore } from '../database/postgres-store.js'
import { brandEnv } from '../../config/index.js'

type CapitalInputs = {
  environment: 'testnet' | 'mainnet'
  store?: PostgresStore
  accountId?: number
  connectionId?: string
  readPerplBalance?: () => ReturnType<PerplAdapter['getBalance']>
  ausd: AusdAdapter
  agoraAusd: AusdAdapter
  agora: AgoraAdapter
  metricsEnabled: boolean
  freshnessThresholds?: { marketMs: number }
}

export async function readCapital(
  inputs: CapitalInputs,
  walletAddress?: string,
  userId?: string,
): Promise<CapitalSnapshot> {
  const {
    environment,
    store,
    accountId,
    connectionId,
    readPerplBalance,
    ausd,
    agoraAusd,
    agora,
    metricsEnabled,
    freshnessThresholds = defaultFreshnessThresholds,
  } = inputs
  const asset = environment === 'testnet' ? 'USD' : 'AUSD'
  let perpl: Awaited<ReturnType<NonNullable<typeof readPerplBalance>>> | undefined
  let perplFree: string | undefined
  try {
    perpl = await readPerplBalance!()
    const free = moneyMicros(perpl.available) - moneyMicros(perpl.locked)
    if (free < 0n) throw new Error('PERPL_BALANCE_INVALID')
    perplFree = formatMoney(free)
  } catch {
    perpl = undefined
  }
  let wallet: Awaited<ReturnType<AusdAdapter['walletBalance']>> | undefined
  let walletUnavailableReason = walletAddress ? 'MONAD_COLLATERAL_READ_FAILED' : 'SESSION_WALLET_UNAVAILABLE'
  if (walletAddress) {
    try {
      wallet = await ausd.walletBalance(getAddress(walletAddress))
    } catch (error) {
      walletUnavailableReason = capitalReadReason(error, 'MONAD_COLLATERAL_READ_FAILED')
    }
  }
  let walletAgora: Awaited<ReturnType<AusdAdapter['walletBalance']>> | undefined
  let agoraUnavailableReason = walletAddress ? 'MONAD_AGORA_AUSD_READ_FAILED' : 'SESSION_WALLET_UNAVAILABLE'
  if (walletAddress) {
    try {
      walletAgora = await agoraAusd.walletBalance(getAddress(walletAddress))
    } catch (error) {
      agoraUnavailableReason = capitalReadReason(error, 'MONAD_AGORA_AUSD_READ_FAILED')
    }
  }
  let ledger: ReturnType<typeof reconcileBookCapital> | undefined
  if (userId && store) {
    try {
      const result = await store!.pool.query(
        `SELECT b.id AS book_id,b.market,r.available::text AS available,r.reserved::text AS reserved,
              r.deployed::text AS deployed,r.updated_at AS updated_at
             FROM books b JOIN reserves r ON r.book_id=b.id
             WHERE b.user_id=$1 AND b.status<>'CLOSED' AND ($2::uuid IS NULL OR b.perpl_connection_id=$2) ORDER BY b.created_at,b.id`,
        [userId, connectionId ?? null],
      )
      const rows: BookCapitalRow[] = result.rows.map((row) => ({
        bookId: String(row.book_id),
        market: String(row.market),
        available: String(row.available),
        reserved: String(row.reserved),
        deployed: String(row.deployed),
        updatedAt: new Date(row.updated_at).toISOString(),
      }))
      ledger = reconcileBookCapital(rows, perplFree)
    } catch {
      // A failed ledger read never becomes a displayed zero.
    }
  }
  let ausdMetrics: ReturnType<typeof publicAusdSupply> | { status: 'UNAVAILABLE'; reason: string } | undefined
  if (metricsEnabled) {
    try {
      ausdMetrics = publicAusdSupply(await agora.metrics())
    } catch {
      ausdMetrics = { status: 'UNAVAILABLE', reason: 'AGORA_METRICS_READ_FAILED' }
    }
  }
  const unavailable = (source: string, reason: string, decimals = 6): CapitalAmount => ({
    amount: null,
    asset,
    decimals,
    source,
    availability: 'UNAVAILABLE',
    freshness: 'UNKNOWN',
    reason,
  })
  const available = (amount: string, source: string, decimals: number, updatedAt?: number): CapitalAmount => {
    if (updatedAt === undefined)
      return { amount, asset, decimals, source, availability: 'AVAILABLE', freshness: 'UNKNOWN' }
    const ageMs = Math.max(0, Date.now() - updatedAt)
    return {
      amount,
      asset,
      decimals,
      source,
      availability: 'AVAILABLE',
      freshness: ageMs <= freshnessThresholds.marketMs ? 'FRESH' : 'STALE',
      ageMs,
      updatedAt: new Date(updatedAt).toISOString(),
    }
  }
  const ledgerReason = !userId
    ? 'SESSION_USER_UNAVAILABLE'
    : !store
      ? 'DATABASE_NOT_CONFIGURED'
      : 'BOOK_LEDGER_READ_FAILED'
  const ledgerUpdatedAt = ledger?.updatedAt ? Date.parse(ledger.updatedAt) : Date.now()
  const ledgerAmount = (amount: string | undefined, reason = ledgerReason) =>
    amount === undefined ? unavailable('EYELER_LEDGER', reason) : available(amount, 'EYELER_LEDGER', 6, ledgerUpdatedAt)
  const walletAmount = (balance: NonNullable<typeof wallet>, source: string, symbol: string): CapitalAmount => ({
    ...available(
      decodeAmount(balance.raw.toString(), balance.decimals),
      source,
      balance.decimals,
      balance.observedAt ?? Date.now(),
    ),
    asset: symbol,
    onChain: {
      wallet: walletAddress!,
      token: balance.token,
      chainId: balance.chainId,
      blockNumber: balance.blockNumber?.toString(),
      explorerUrl: `https://${environment === 'testnet' ? 'testnet.' : ''}monadexplorer.com/address/${walletAddress!}`,
    },
  })
  return {
    status: wallet || walletAgora || perpl || ledger ? ('VALID' as const) : ('UNAVAILABLE' as const),
    accountId,
    walletAusd: wallet
      ? walletAmount(wallet, 'MONAD_COLLATERAL', asset)
      : unavailable('MONAD_COLLATERAL', walletUnavailableReason),
    walletAgoraAusd: walletAgora
      ? walletAmount(walletAgora, 'MONAD_AGORA_AUSD', 'AUSD')
      : { ...unavailable('MONAD_AGORA_AUSD', agoraUnavailableReason), asset: 'AUSD' },
    perplAvailable:
      perpl && perplFree
        ? available(perplFree, 'PERPL_COLLATERAL', perpl.decimals, perpl.updatedAt)
        : unavailable('PERPL_COLLATERAL', readPerplBalance ? 'PERPL_BALANCE_READ_FAILED' : 'PERPL_NOT_CONNECTED'),
    perplLocked: perpl
      ? available(perpl.locked, 'PERPL_COLLATERAL', perpl.decimals, perpl.updatedAt)
      : unavailable('PERPL_COLLATERAL', readPerplBalance ? 'PERPL_BALANCE_READ_FAILED' : 'PERPL_NOT_CONNECTED'),
    bookReserved: ledgerAmount(ledger?.reserved),
    bookDeployed: ledgerAmount(ledger?.deployed),
    bookRemaining: ledgerAmount(ledger?.available),
    unreservedCapital: ledgerAmount(
      ledger?.unreserved ?? undefined,
      perplFree ? ledgerReason : readPerplBalance ? 'PERPL_BALANCE_READ_FAILED' : 'PERPL_NOT_CONNECTED',
    ),
    bookAllocations: ledger?.allocations,
    reserveCoverage: ledger?.coverage,
    ausd: wallet
      ? {
          raw: wallet.raw.toString(),
          decimals: wallet.decimals,
          symbol: asset,
          token: wallet.token,
          chainId: wallet.chainId,
        }
      : undefined,
    ausdMetrics,
  }
}

function capitalReadReason(error: unknown, fallback: string): string {
  // Only known public reason codes can cross the API boundary; RPC errors can contain credentials.
  return error instanceof Error && ['MONAD_CHAIN_MISMATCH', 'INVALID_TOKEN_SNAPSHOT'].includes(error.message)
    ? error.message
    : fallback
}

/** Public wallet reads do not require a Perpl API key, private socket or funded account. */
export function createPublicCapital(store: PostgresStore | undefined, env: Record<string, string | undefined>) {
  const environment = brandEnv(env, 'ENV')
  if (environment !== 'testnet' && environment !== 'mainnet') return undefined
  const network = perplNetworks[environment]
  const chain = (token: Address) =>
    new ChainAdapter(environment, {
      rpcUrl: env.MONAD_RPC_URL ?? network.rpcUrl,
      chainId: network.chainId,
      ausdToken: token,
    })
  const inputs: CapitalInputs = {
    environment,
    store,
    ausd: new AusdAdapter(chain(getAddress(network.collateralToken))),
    agoraAusd: new AusdAdapter(chain(chainConfigs[environment].ausdToken)),
    agora: new AgoraAdapter(env.AGORA_API_URL, env.AGORA_API_KEY),
    metricsEnabled: env.AGORA_METRICS_ENABLED === 'true',
  }
  return (wallet: string, userId: string) => readCapital(inputs, wallet, userId)
}
