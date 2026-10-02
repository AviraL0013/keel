import type { AgoraActivity } from '../../../../packages/domain/src/index.js'
import type { AgoraAdapter, AgoraCounterparty } from '../../../../packages/chain/src/agora.js'
import { formatMoney, moneyMicros } from '../../../../packages/ausd/src/money.js'

type Evidence = 'WALLET_TRANSFER' | 'WALLET_AND_PERPL' | 'NONE'
type EvidenceLookup = (transactionHash: string, amount: string, wallet: string) => Promise<Evidence>

function isWallet(side: AgoraCounterparty, wallet: string) {
  return (
    side.kind === 'wallet' &&
    side.chain?.toLowerCase() === 'monad' &&
    side.address?.toLowerCase() === wallet.toLowerCase()
  )
}
function label(side: AgoraCounterparty, wallet: string) {
  if (isWallet(side, wallet)) return 'Your Monad wallet'
  return side.kind === 'bank' ? 'Other bank account' : 'Other account'
}

/** Projects only connected-wallet records. No organization account or bank details leave this service. */
export async function readAgoraActivity(
  agora: AgoraAdapter,
  wallet: string | undefined,
  evidenceLookup: EvidenceLookup,
  cursor?: string,
): Promise<AgoraActivity> {
  if (!wallet) return { status: 'UNAVAILABLE', reason: 'WALLET_NOT_CONNECTED', rows: [] }
  try {
    const accounts = await agora.listAccounts()
    const registered = accounts.some(
      (account) =>
        account.address?.toLowerCase() === wallet.toLowerCase() &&
        account.networks?.some((network) => network.chain.toLowerCase() === 'monad'),
    )
    if (!registered) return { status: 'UNAVAILABLE', reason: 'WALLET_NOT_REGISTERED', rows: [] }
    const page = await agora.listTransactions(cursor)
    if (!Array.isArray(page.data)) throw new Error('AGORA_TRANSACTIONS_INVALID_RESPONSE')
    const selected = page.data.filter(
      (transaction) => isWallet(transaction.source, wallet) || isWallet(transaction.recipient, wallet),
    )
    const rows: AgoraActivity['rows'] = []
    for (const item of selected) {
      const detail = await agora.transaction(item.id)
      const walletIsSource = isWallet(detail.source, wallet)
      const walletSide = walletIsSource ? detail.source : detail.recipient
      const ausd = walletSide.amounts?.find((value) => value.currency.toLowerCase() === 'ausd')
      let evidence: Evidence = 'NONE'
      let transactionHash: string | undefined
      for (const leg of detail.legs ?? []) {
        const hash = leg.detail?.transactionHash
        if (
          leg.detail?.type !== 'token' ||
          !hash ||
          !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
          leg.currency.toLowerCase() !== 'ausd'
        )
          continue
        if (!isWallet(leg.source, wallet) && !isWallet(leg.recipient, wallet)) continue
        transactionHash = hash
        evidence = await evidenceLookup(hash, leg.amount, wallet)
        if (evidence !== 'NONE') break
      }
      rows.push({
        id: detail.id,
        type: detail.type,
        status: detail.status,
        source: label(detail.source, wallet),
        destination: label(detail.recipient, wallet),
        asset: 'AUSD',
        amount: ausd ? formatMoney(moneyMicros(ausd.amount)) : '',
        timestamp: detail.settledAt ?? detail.initiatedAt,
        match: evidence === 'NONE' ? 'UNMATCHED' : 'POSSIBLE_MATCH',
        evidence,
        transactionHash,
      })
    }
    return {
      status: 'AVAILABLE',
      checkedAt: new Date().toISOString(),
      limited: page.nextCursor !== null,
      nextCursor: page.nextCursor ?? undefined,
      rows,
    }
  } catch {
    return { status: 'UNAVAILABLE', reason: 'AGORA_READ_FAILED', rows: [] }
  }
}
