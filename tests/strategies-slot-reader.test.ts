import { describe, expect, it, vi } from 'vitest'
import { StrategyLifecycleReader } from '../packages/perpl/src/strategy-lifecycle-reader.js'

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
function fixture() {
  const calls: Array<{ method: string; params: unknown[] }> = []
  let altered = false
  const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init?.body))
    calls.push({ method, params })
    let result: unknown
    if (method === 'eth_chainId') result = '0x8f'
    else if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'finalized' ? 115 : Number(BigInt(params[0]))
      result = {
        number: `0x${number.toString(16)}`,
        hash: altered && number === 112 ? hash(999) : hash(number),
        parentHash: hash(number - 1),
        transactions:
          params[1] && number === 112
            ? [
                {
                  hash: hash(11200),
                  to: null,
                  input: '0x',
                  blockNumber: '0x70',
                  blockHash: hash(112),
                  transactionIndex: '0x0',
                },
              ]
            : [],
      }
      if (number === 112 && params[1]) altered = false
    } else if (method === 'eth_getTransactionReceipt')
      result = {
        status: '0x0',
        to: null,
        logs: [],
        blockNumber: '0x70',
        blockHash: hash(112),
        transactionIndex: '0x0',
        transactionHash: params[0],
      }
    else throw Error(`Unexpected fixture method: ${method}`)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
  return {
    calls,
    transport,
    reorg: () => {
      altered = true
    },
  }
}
describe('bounded read-only strategy slot RPC inventory', () => {
  it('enumerates empty blocks and every receipt, then rechecks the canonical tip without eth_getLogs or writes', async () => {
    const value = fixture()
    const reader = new StrategyLifecycleReader('https://fixture-rpc.invalid', 143, value.transport as typeof fetch)
    const proof = await reader.read(110, 112)
    expect(proof.blocks).toHaveLength(3)
    expect(proof.blocks[2].receipts).toHaveLength(1)
    expect(proof.finalized).toEqual({ block: 115, hash: hash(115) })
    expect(value.calls.map((call) => call.method)).toEqual([
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
      'eth_getTransactionReceipt',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
    ])
    expect(value.calls.filter((call) => call.method === 'eth_getBlockByNumber').map((call) => call.params)).toEqual([
      ['finalized', false],
      ['0x6e', true],
      ['0x6f', true],
      ['0x70', true],
      ['0x70', false],
      ['0x73', false],
    ])
  })
  it('fails closed when finality is absent or the target is not finalized', async () => {
    for (const finality of [null, { number: '0x6f', hash: hash(111) }]) {
      const value = fixture()
      const transport = async (url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body))
        return request.params[0] === 'finalized'
          ? new Response(JSON.stringify({ result: finality }))
          : value.transport(url, init)
      }
      await expect(
        new StrategyLifecycleReader('https://fixture-rpc.invalid', 143, transport as typeof fetch).read(110, 112),
      ).rejects.toThrow('PERPL_SLOT_FINALITY_UNAVAILABLE')
    }
  })
  it('never reads from a wrong chain or a truncated/oversized interval', async () => {
    const value = fixture()
    await expect(
      new StrategyLifecycleReader('https://fixture-rpc.invalid', 10143, value.transport as typeof fetch).read(110, 112),
    ).rejects.toThrow('PERPL_SLOT_CHAIN_MISMATCH')
    expect(value.calls).toHaveLength(1)
    value.calls.length = 0
    for (const bounds of [
      [0, 1],
      [112, 110],
      [1, 130],
      [1.1, 2],
    ])
      await expect(
        new StrategyLifecycleReader('https://fixture-rpc.invalid', 143, value.transport as typeof fetch).read(
          bounds[0],
          bounds[1],
        ),
      ).rejects.toThrow('PERPL_SLOT_SCAN_LIMIT')
    expect(value.calls).toHaveLength(0)
  })
  it('rejects missing receipts, mismatched stamps and parent hashes; no fallback to a topic scan', async () => {
    for (const corrupt of [
      (request: { method: string; params: unknown[] }, response: Record<string, unknown>) => {
        if (request.method === 'eth_getTransactionReceipt') response.result = null
      },
      (request: { method: string; params: unknown[] }, response: Record<string, unknown>) => {
        if (request.method === 'eth_getTransactionReceipt')
          (response.result as Record<string, unknown>).blockHash = hash(999)
      },
      (request: { method: string; params: unknown[] }, response: Record<string, unknown>) => {
        if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x6f')
          (response.result as Record<string, unknown>).parentHash = hash(999)
      },
    ]) {
      const value = fixture()
      const transport = async (url: string | URL | Request, init?: RequestInit) => {
        const response = await (await value.transport(url, init)).json()
        corrupt(JSON.parse(String(init?.body)), response)
        return new Response(JSON.stringify(response))
      }
      await expect(
        new StrategyLifecycleReader('https://fixture-rpc.invalid', 143, transport as typeof fetch).read(110, 112),
      ).rejects.toThrow()
      expect(value.calls.every((call) => !/send|Logs/i.test(call.method))).toBe(true)
    }
  })
  it('rejects a reorg detected after fetching all receipts', async () => {
    const value = fixture()
    const transport = async (url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x70' && request.params[1] === false)
        value.reorg()
      return value.transport(url, init)
    }
    await expect(
      new StrategyLifecycleReader('https://fixture-rpc.invalid', 143, transport as typeof fetch).read(110, 112),
    ).rejects.toThrow('PERPL_SLOT_HISTORY_REORG')
  })
  it.each([112, 115])(
    'rejects a conflicting finalized hash at height %i rather than labeling the inventory finalized',
    async (number) => {
      const value = fixture()
      const transport = async (url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body))
        if (request.method === 'eth_getBlockByNumber' && request.params[0] === 'finalized')
          return new Response(JSON.stringify({ result: { number: `0x${number.toString(16)}`, hash: hash(999) } }))
        return value.transport(url, init)
      }
      await expect(
        new StrategyLifecycleReader('https://fixture-rpc.invalid', 143, transport as typeof fetch).read(110, 112),
      ).rejects.toThrow('PERPL_SLOT_HISTORY_REORG')
    },
  )
  it.each([401, 403])('stops immediately on HTTP %i without retry or alternate provider', async (status) => {
    const transport = vi.fn(async () => new Response('fixture denial', { status }))
    await expect(
      new StrategyLifecycleReader('https://fixture-rpc.invalid', 143, transport as typeof fetch).read(110, 112),
    ).rejects.toThrow(`PERPL_SLOT_HISTORY_HTTP_${status}`)
    expect(transport).toHaveBeenCalledTimes(1)
  })
})
