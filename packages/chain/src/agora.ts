export type AgoraMetrics = { [key: string]: unknown }
export type AgoraEnvironment = 'production'
export class AgoraAdapter { constructor(private readonly baseUrl = 'https://api.agora.finance', private readonly apiKey?: string) {}
  async metrics(): Promise<AgoraMetrics> { const response = await fetch(`${this.baseUrl}/v0/metrics`); if (!response.ok) throw new Error(`AGORA_METRICS_HTTP_${response.status}`); return await response.json() as AgoraMetrics }
  async session(): Promise<string> { if (!this.apiKey) throw new Error('AGORA_API_KEY_NOT_CONFIGURED'); const response = await fetch(`${this.baseUrl}/v0/auth/session`, { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` } }); if (!response.ok) throw new Error(`AGORA_AUTH_HTTP_${response.status}`); const body = await response.json() as { token: string }; return body.token }
  async listTransactions(token: string) { const response = await fetch(`${this.baseUrl}/v0/transactions`, { headers: { authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`AGORA_TRANSACTIONS_HTTP_${response.status}`); return await response.json() as unknown }
}
