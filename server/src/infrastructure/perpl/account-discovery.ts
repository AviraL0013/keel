import type { PerplWalletSnapshot } from '../../../../packages/perpl/src/history.js'

/** Accept account identity only from authenticated, stamped wallet state. */
export function discoverPerplAccount(snapshot: PerplWalletSnapshot, walletAddress: string) {
  const wallet = snapshot as PerplWalletSnapshot & {
    addr?: string
    as: Array<{ id: number; fr?: boolean; fw?: boolean }>
  }
  if (wallet.addr?.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('PERPL_WALLET_MISMATCH')
  if (!Number.isSafeInteger(wallet.at?.b) || wallet.at.b! <= 0 || !Array.isArray(wallet.as))
    throw new Error('PERPL_WALLET_SNAPSHOT_INVALID')
  if (wallet.as.length === 0) throw new Error('PERPL_ACCOUNT_NOT_ACTIVE')
  if (wallet.as.length !== 1) throw new Error('PERPL_ACCOUNT_SELECTION_REQUIRED')
  const account = wallet.as[0]
  if (!Number.isSafeInteger(account.id) || account.id <= 0) throw new Error('PERPL_ACCOUNT_INVALID')
  if (account.fr !== false || account.fw !== true) throw new Error('PERPL_ACCOUNT_TRADING_UNAVAILABLE')
  return { accountId: account.id, observedBlock: wallet.at.b! }
}
