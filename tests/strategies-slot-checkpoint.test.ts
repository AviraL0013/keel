import { expect, it } from 'vitest'
import { slotFixture, block, maker, hash, exchange } from './helpers/strategy-slot.js'
import { advanceStrategySlot, verifyStrategyMakerFill } from '../packages/perpl/src/strategy-lifecycle.js'

it('resumes a finalized slot replay past the 128-block reader bound without resetting its remaining size', () => {
  const value = slotFixture()
  const prefix = [...value.blocks, ...Array.from({ length: 125 }, (_, i) => block(113 + i, []))]
  const result = advanceStrategySlot(exchange, value.admission, prefix)
  expect(result.status).toBe('CHECKPOINT')
  if (result.status !== 'CHECKPOINT') throw Error('checkpoint missing')
  expect(result.checkpoint).toMatchObject({
    throughBlock: 237,
    blockHash: hash(237),
    remainingSizeRaw: '70',
    ended: false,
  })
  const tail = [block(238, []), block(239, []), block(240, [{ events: [maker(70n)] }])]
  const candidate = { ...value.candidate, s: 70, at: { b: 240, tx: 0, l: 0, txid: hash(24000).slice(2) } }
  expect(verifyStrategyMakerFill(exchange, value.admission, candidate, tail, result.checkpoint)).toMatchObject({
    status: 'VERIFIED',
    fill: { sizeRaw: '70', fullyFilled: true },
  })
})

it('rejects a replay gap, changed admission, broken parent hash and ended generation checkpoint', () => {
  const value = slotFixture()
  const result = advanceStrategySlot(exchange, value.admission, value.blocks)
  if (result.status !== 'CHECKPOINT') throw Error('checkpoint missing')
  const candidate = { ...value.candidate, s: 70, at: { b: 113, tx: 0, l: 0, txid: hash(11300).slice(2) } }
  const tail = [block(113, [{ events: [maker(70n)] }])]
  expect(
    verifyStrategyMakerFill(exchange, { ...value.admission, requestId: '46' }, candidate, tail, result.checkpoint)
      .status,
  ).toBe('UNKNOWN')
  expect(
    verifyStrategyMakerFill(exchange, value.admission, candidate, tail, { ...result.checkpoint, throughBlock: 111 })
      .status,
  ).toBe('UNKNOWN')
  tail[0].block.parentHash = hash(999)
  expect(verifyStrategyMakerFill(exchange, value.admission, candidate, tail, result.checkpoint).status).toBe('UNKNOWN')
  tail[0].block.parentHash = hash(112)
  expect(
    verifyStrategyMakerFill(exchange, value.admission, candidate, tail, { ...result.checkpoint, ended: true }).status,
  ).toBe('UNKNOWN')
})
