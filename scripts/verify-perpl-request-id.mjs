// Read-only historical verification. No signing, transaction submission, or state overrides.
import assert from 'node:assert/strict'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, keccak256 } from 'viem'

const rpcUrl = 'https://testnet-rpc.monad.xyz'
const exchange = '0x1964c32f0be608e7d29302aff5e61268e72080cc'
const txHash = '0x22951e0d54b39db37f84cd51139064b75674bf84c725bc21c42b2f2c2823328b'
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
async function rpc(method, params) {
  assert(['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getStorageAt', 'eth_getCode', 'eth_blockNumber', 'debug_traceCall'].includes(method))
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) })
  const value = await response.json()
  if (!response.ok || value.error) throw new Error(JSON.stringify(value.error ?? response.status))
  return value.result
}
const response = await fetch('https://raw.githubusercontent.com/PerplFoundation/dex-sdk/main/crates/sdk/abi/dex/Exchange.json')
if (!response.ok) throw new Error(`SDK_HTTP_${response.status}`)
const { abi } = await response.json()
const tx = await rpc('eth_getTransactionByHash', [txHash])
assert.equal(tx.to.toLowerCase(), exchange)
const receipt = await rpc('eth_getTransactionReceipt', [txHash])
const parent = '0x' + (BigInt(receipt.blockNumber) - 1n).toString(16)
const block = await rpc('eth_blockNumber', [])
const implementation = '0x' + (await rpc('eth_getStorageAt', [exchange, implementationSlot, block])).slice(-40)
const previousImplementation = '0x' + (await rpc('eth_getStorageAt', [exchange, implementationSlot, parent])).slice(-40)
const code = await rpc('eth_getCode', [implementation, block])
const previousCode = await rpc('eth_getCode', [previousImplementation, parent])
assert.equal(code, previousCode, 'Implementation changed since the failed transaction; re-investigate the current rule')
assert.equal(keccak256(code), '0x29ef64f8efca11ce9cd1f0ab39ef08cd7bd02955b52075db44be95a8b4dcf620')
console.log(JSON.stringify({ block, parent, implementation, codeHash: keccak256(code) }))
const decoded = decodeFunctionData({ abi, data: tx.input })
assert.equal(decoded.functionName, 'execFwdPositionOpsV2')
assert.equal(decoded.args[0].length, 1)
assert.equal(decoded.args[0][0].accountId, 642n)
assert.equal(decoded.args[0][0].orderDesc.orderDescId, 1790412137977n)
for (const rq of [1790412137977n, 1791001362433n]) {
  const args = structuredClone(decoded.args)
  args[0][0].orderDesc.orderDescId = rq
  const data = encodeFunctionData({ abi, functionName: decoded.functionName, args })
  const trace = await rpc('debug_traceCall', [{ from: tx.from, to: exchange, data, gas: '0x989680' }, parent, { tracer: 'callTracer', tracerConfig: { withLog: true } }])
  assert.equal(trace.error, undefined)
  const events = []
  function visit(frame) {
    for (const log of frame.logs ?? []) {
      try {
        const event = decodeEventLog({ abi, data: log.data, topics: log.topics })
        if (['OrderDescIdTooLow', 'IncreasePositionCollateral'].includes(event.eventName)) events.push(event)
      } catch { /* Unrelated external contract event. */ }
    }
    for (const child of frame.calls ?? []) visit(child)
  }
  visit(trace)
  assert.deepEqual(events.map(event => event.eventName), [rq === 1790412137977n ? 'OrderDescIdTooLow' : 'IncreasePositionCollateral'])
  console.log(JSON.stringify({ simulationOnly: true, rq, events }, (_, value) => typeof value === 'bigint' ? value.toString() : value))
}
