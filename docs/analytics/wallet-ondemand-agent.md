# Wallet analytics on demand: route wiring

`WalletOnDemandAnalytics` lives in `server/src/infrastructure/analytics/wallet-ondemand.ts`. The integrator owns `server/src/interfaces/http/routes/analytics.ts`; that file is intentionally unchanged on this branch.

## What the helper returns

`load()` reads the last 30 days ending at a finalized Monad block, scans Perpl Exchange events through HyperSync, and returns `WalletOnDemandResult`. Its `label` is exactly `last 30 days`; `from` and `through` are UTC ISO timestamps. `trades` contains only fills or liquidations with proven wallet ownership and unambiguous attribution. `performance` contains closed trades, realized PnL, win rate, profit factor, streaks, hold time, best/worst market, and an optional realized equity curve and maximum percentage drawdown. All money uses six-decimal AUSD strings.

The helper caches each wallet, account set, market precision set, enumeration flag, and starting-equity input for 60 seconds. Concurrent calls share the same promise. Failed scans are evicted. HyperSync pages must cover the complete `[fromBlock, finalizedBlock + 1)` range, and their block hashes are checked against log hashes. Ownership is checked with `historicalAccountOwner` at each candidate account's event block. The finalized RPC block is reread after the scan. A partial liquidation reduces the open episode; a full liquidation closes it. A liquidation and position settlement for the same account/market in one transaction leave totals unavailable to avoid double counting.

HyperSync can filter the Exchange address and event signatures, but Perpl puts account IDs in **unindexed event data**. Its log API cannot filter directly by account ID. The helper therefore decodes Exchange logs and retains transactions containing candidate account IDs. It does not use transaction sender as taker identity. A taker fill has no account or market ID; it is attributed only when exactly one unmatched position event remains after maker matching in that transaction. Multiple maker fills for the same account/market and ambiguous taker transactions set `performance: null` with `unavailableReason`. Unsupported deleverage/unwind settlements, missing opening events, failed historical owner checks, and unverified account enumeration also keep performance unavailable. The `trades` list can then be partial and must be shown as such.

`maxDrawdownPct` is null unless the caller supplies **proven Exchange equity at the window start** as `startingEquityMicros`. Current margin or wallet token balance is not a valid substitute. `maxDrawdownUnavailableReason` is `STARTING_EQUITY_UNAVAILABLE` when no positive baseline is supplied. The curve applies realized settlement PnL to that starting equity; it is not a mark-to-market equity curve.

## Exact route integration

1. Add `walletOnDemand?: WalletOnDemandAnalytics` to `AnalyticsRouteDependencies`. Import `WalletOnDemandAnalytics` and `walletOnDemandFromEnv` from `../../../infrastructure/analytics/wallet-ondemand.js`.
2. In `registerAnalyticsRoutes`, construct one service instance, after `wallet`:

   ```ts
   const onDemand = dependencies.walletOnDemand ?? (
     process.env.EYELER_HYPERSYNC_TOKEN
       ? walletOnDemandFromEnv(analyticsWalletRpcUrl(process.env))
       : null
   )
   ```

   Set `EYELER_HYPERSYNC_TOKEN` in server environment. Never expose it to mobile clients, logs, URLs, or response bodies. The default HyperSync endpoint is `https://monad.hypersync.xyz` (chain 143). `EYELER_ANALYTICS_RPC_URL` must provide finalized and historical block/account reads.

3. In wallet-open handling (`/wallets/:address` and/or a dedicated last-30-days endpoint), call `publicData.context()` and `wallet.profile(address, ctx.value)` as now. Enumerate candidate IDs from the indexed `analytics_accounts` table **and** the current profile. The table's creation address alone is not proof of owner at settlement time; the helper checks that. Use:

   ```ts
   if (!onDemand) throw fail('HYPERSYNC_TOKEN_UNAVAILABLE', 503)
   const ctx = await publicData.context()
   const profile = await wallet.profile(address, ctx.value)
   const rows = await db().query(
     'SELECT account_id::text AS account_id FROM analytics_accounts WHERE address=$1',
     [address.toLowerCase()],
   )
   const accountIds = [...new Set([
     ...rows.rows.map((row: { account_id: string }) => row.account_id),
     ...(profile?.data.accountIds ?? []),
   ])]
   const verifiedAccountEnumeration = false // Set true only after a separate complete account census.
   const result = await onDemand.load({
     address,
     accountIds,
     accountsComplete: verifiedAccountEnumeration,
     context: ctx.value,
     // startingEquityMicros: provenCutoffEquity, when available
   })
   reply.header('Cache-Control', 'public, max-age=60')
   return result
   ```

   `verifiedAccountEnumeration` must be true only after a complete account census for this wallet, including accounts that it owned during the window but does not own now. The existing creation-address index plus current profile does **not** establish this if ownership can change. Pass `false` until the integrator has that proof. The helper still returns individually proven trades, but withholds performance totals. An empty, verified account set can produce zero activity; an empty, unverified set cannot.

4. Map `result.trades` to the last-30-days trade response and `result.performance` to the last-30-days performance response. Preserve `label`, `from`, `through`, `unavailableReason`, and `maxDrawdownUnavailableReason` in each response or a shared envelope. Do not silently fall back to all-time database performance or render null as zero. If `result.performance` is null, all aggregate values are unavailable for the stated reason. Keep route limits and authentication already applied to private wallet endpoints.

## Verification and limits

Focused tests are in `tests/analytics-wallet-ondemand.test.ts`. They cover maker/taker attribution, partial reductions, ambiguous multi-fill transactions, changed ownership, incomplete opening and enumeration evidence, unsupported settlements, unknown market mapping, token placement, and cache reuse. `tests/analytics-performance.test.ts` covers episode arithmetic. A bounded live HyperSync query against a recorded Perpl block confirmed that the HTTP response has a `data` array containing block and log batches with numeric block fields. The helper limits retained wallet-related logs to 100,000 and HyperSync pages to 500; an exceeded limit fails the request rather than publishing partial totals. Full live wallet/RPC integration remains subject to configured credentials and provider availability.

HyperSync query shape and `next_block` pagination follow [Envio's query reference](https://docs.envio.dev/docs/HyperSync/hypersync-query); [Envio's network list](https://docs.envio.dev/docs/HyperSync/hypersync-supported-networks) lists Monad chain 143 and the endpoint above.
