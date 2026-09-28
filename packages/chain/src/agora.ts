export type AgoraMetrics = Record<string, unknown>
export type AgoraEnvironment = 'production'
export type AgoraWalletAccount = { id: string; kind: string; address?: string; networks?: Array<{ chain: string }> }
export type AgoraCounterparty = {
  kind: string
  address?: string | null
  chain?: string | null
  amounts?: Array<{ amount: string; currency: string }>
}
export type AgoraTransaction = {
  id: string
  type: string
  status: string
  initiatedAt: string
  settledAt: string | null
  source: AgoraCounterparty
  recipient: AgoraCounterparty
}
export type AgoraLeg = {
  amount: string
  currency: string
  occurredAt: string
  source: AgoraCounterparty
  recipient: AgoraCounterparty
  detail: { type: string; transactionHash?: string }
}
export type AgoraTransactionDetail = AgoraTransaction & { legs: AgoraLeg[] }
type Page<T> = { data: T[]; nextCursor: string | null }

/** Server-side, read-only Agora API client. Never return the session token to callers. */
export class AgoraAdapter {
  private sessionJwt?: string
  private sessionExpiresAt = 0
  constructor(
    private readonly baseUrl = 'https://api.agora.finance',
    private readonly apiKey?: string,
    private readonly recordRequestId: (requestId: string | null, path: string, status: number) => void = () => {},
    private readonly request: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, token?: string): Promise<T> {
    const response = await this.request(`${this.baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    })
    this.recordRequestId(response.headers.get('Request-Id'), path.split('?')[0], response.status)
    if (!response.ok) throw new Error(`AGORA_HTTP_${response.status}`)
    return (await response.json()) as T
  }
  async metrics(): Promise<AgoraMetrics> {
    return this.call<AgoraMetrics>('/v0/metrics')
  }
  private async session(): Promise<string> {
    if (!this.apiKey) throw new Error('AGORA_API_KEY_NOT_CONFIGURED')
    if (this.sessionJwt && Date.now() < this.sessionExpiresAt) return this.sessionJwt
    const response = await this.request(`${this.baseUrl}/v0/auth/token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
    })
    this.recordRequestId(response.headers.get('Request-Id'), '/v0/auth/token', response.status)
    if (!response.ok) throw new Error(`AGORA_AUTH_HTTP_${response.status}`)
    const body = (await response.json()) as { sessionJwt?: string }
    if (!body.sessionJwt) throw new Error('AGORA_AUTH_INVALID_RESPONSE')
    this.sessionJwt = body.sessionJwt
    this.sessionExpiresAt = Date.now() + 14 * 60_000
    return body.sessionJwt
  }
  private async authenticated<T>(path: string): Promise<T> {
    const token = await this.session()
    try {
      return await this.call<T>(path, token)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'AGORA_HTTP_401') throw error
      this.sessionJwt = undefined
      return this.call<T>(path, await this.session())
    }
  }
  async listAccounts(): Promise<AgoraWalletAccount[]> {
    const result: AgoraWalletAccount[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const path: string = `/v0/accounts?kind=wallet&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const response: Page<AgoraWalletAccount> = await this.authenticated<Page<AgoraWalletAccount>>(path)
      if (!Array.isArray(response.data)) throw new Error('AGORA_ACCOUNTS_INVALID_RESPONSE')
      result.push(
        ...response.data
          .filter((account) => account.kind === 'wallet')
          .map((account) => ({
            id: account.id,
            kind: account.kind,
            address: account.address,
            networks: account.networks,
          })),
      )
      cursor = response.nextCursor
      if (!cursor) return result
    }
    throw new Error('AGORA_ACCOUNTS_INCOMPLETE')
  }
  async listTransactions(): Promise<Page<AgoraTransaction>> {
    return this.authenticated<Page<AgoraTransaction>>('/v0/transactions?limit=200')
  }
  async transaction(id: string): Promise<AgoraTransactionDetail> {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('AGORA_TRANSACTION_ID_INVALID')
    return this.authenticated<AgoraTransactionDetail>(`/v0/transactions/${id}`)
  }
}
