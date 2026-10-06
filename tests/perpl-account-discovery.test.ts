import { expect, it } from 'vitest'
import { discoverPerplAccount } from '../server/src/infrastructure/perpl/account-discovery.js'

const address = '0x0000000000000000000000000000000000000001'
const snapshot = { addr: address, at: { b: 100 }, as: [{ id: 642, b: '10000000', lb: '0', fw: true, fr: false }] }
it('takes the account only from signed wallet identity and stamped account state', () => {
  expect(discoverPerplAccount(snapshot, address)).toEqual({ accountId: 642, observedBlock: 100 })
  expect(() => discoverPerplAccount(snapshot, '0x0000000000000000000000000000000000000002')).toThrow(
    'PERPL_WALLET_MISMATCH',
  )
  expect(() => discoverPerplAccount({ ...snapshot, as: [] }, address)).toThrow('PERPL_ACCOUNT_NOT_ACTIVE')
  expect(() =>
    discoverPerplAccount({ ...snapshot, as: [...snapshot.as, { ...snapshot.as[0], id: 777 }] }, address),
  ).toThrow('PERPL_ACCOUNT_SELECTION_REQUIRED')
  expect(() => discoverPerplAccount({ ...snapshot, as: [{ ...snapshot.as[0], fr: true }] }, address)).toThrow(
    'PERPL_ACCOUNT_TRADING_UNAVAILABLE',
  )
  expect(() => discoverPerplAccount({ ...snapshot, as: [{ ...snapshot.as[0], fw: false }] }, address)).toThrow(
    'PERPL_ACCOUNT_TRADING_UNAVAILABLE',
  )
  expect(() => discoverPerplAccount({ ...snapshot, at: { b: 0 } }, address)).toThrow('PERPL_WALLET_SNAPSHOT_INVALID')
})
