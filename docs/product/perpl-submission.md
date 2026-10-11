# Best Use of Perpl's API: submission readiness

Candidate: `feat/perpl-bounty-submission`, based on main `0fd7d2d`. This document describes the candidate source, not a verified deployment. It supersedes older readiness summaries for this bounty without rewriting their historical evidence. Commit and push packaging does not establish CI, deployment, profitability or autonomous on-chain proof.

## Product and honest verdict

EYELER is a mobile-controlled, risk-bounded **position-protection automation system on Perpl**. The user chooses a position, allocates a defense reserve, sets a liquidation-distance floor, defense cap, stance and time limit, then explicitly arms a Book. The server monitors it independently of the phone and chooses HOLD, bounded DEFEND, reduce-only REDUCE or EXIT. Autopsy explains the decision and separates an attempted action from verified completion.

The [bounty](https://hackathon.monad.xyz/tracks/best-use-of-perpl-s-api) screenshot supplied for this audit asks for reliable execution, risk management, ability to be profitable and demonstrated real on-chain activity, plus a working system link and a video up to two minutes. Protection is the mounted automation path. A market maker, grid or Telegram order-entry bot is not required by the supplied criteria, and adding an unfinished LIVE strategy would not strengthen this candidate.

The code is a credible candidate, **not yet a proved strongest or production-ready submission**. The user-reported manual mainnet trade is useful trading-path evidence, but is not proof of autonomous execution. New code must pass release gates and be deployed separately. A reviewed real automated run, independent chain evidence and the final video/link remain required. Neither safety controls nor a small successful trade guarantees profitability.

## Criteria and proof

| Criterion | Implemented path | Reproducible proof | Submission gap |
| --- | --- | --- | --- |
| Working Perpl automation | Mounted runtime refresh → risk policy → durable action → owner-bound venue → reconciliation | `agora-journey.test.ts` covers automated EXIT; `perpl-bounty-automation.test.ts` covers DEFEND and HARVEST/REDUCE across restart | Real authorized automatic action with the candidate deployed |
| Reliable execution | Exact request/sequence/deadline persisted before wire; final authorization; ambiguous outcomes reconcile without resend; fenced unsent recovery pauses Book | `perpl-book-durable-submission.test.ts`, `perpl-trading.test.ts`, `execution-unsent-recovery.test.ts`, `execution-recovery.test.ts`, opening reconciliation tests | Sustained forward run, observed latency/fault recovery and candidate deployment checks |
| Risk management | Explicit arm/pause/kill; freshness/SAFE_MODE; reserve/cap/account-capital binding; bounded DEFEND; reduce-only closes; tenant isolation | Risk, reserve, capital, user-venue and execution suites; final-send regressions cover pause, cap changes, global stop and stale data | Reviewed capital, loss limits, fresh Book/time limit and live control demonstration |
| Ability to be profitable | Defense limits and HARVEST constrain exposure; separate strategy evaluations include fees/funding/stress | Committed 30-day fixture, disjoint train/holdout and 24 sensitivity runs | No robust profitable entry strategy or complete net realized Book P&L is proved |
| Real on-chain activity | Venue reconciliation and stored request/block/hash evidence; Autopsy and scoped run report | Report provenance/status/identity/deadline tests; mobile evidence tests | Independently check real receipts/logs and bind them to the automatic action, account and resulting position |
| Deliverables | Native app, backend source, evidence export, demo script below | Full source/build/test gates | Published candidate link and real video ≤120 seconds |

Every offline test uses synthetic transport, accounts, receipts and/or local databases. Even a realistic fixture explorer URL is **not** on-chain submission proof.

## Hardening in this candidate

- Recheck current Book policy, automation/manual authority, defense budget, fresh observations, account connection and global stop immediately before submission, after asynchronous venue preparation.
- Persist the allocated request identity and PREPARED heartbeat metadata before socket write. The wire uses the same persisted deadline; preparation does not silently extend validity. Reject a deadline reached during preparation.
- Preserve durable progress across transport results. Proven pre-send refusal clears submission identity rather than leaving a fictional submitted attempt.
- Preserve observed opening operation evidence across lagged polls. A later empty response cannot erase positive evidence and manufacture an expiry proof; conflicts fail closed and bounded evidence overflow remains unresolved.
- Reclaim only new, protocol-marked attempts that are old, unreferenced and provably unsent. Pause the Book; fence delayed preparation and terminal-state revival. Referenced/UNKNOWN/PARTIAL and unmarked legacy attempts still require reconciliation or operator investigation, never age-based resend. Preserve the existing internal correction of a legacy failed DEFEND when authoritative receipt reconciliation confirms it; that exception cannot revive a protocol-marked or reclaimed attempt.
- Record automatic/manual origin when the action is queued. Report Book/action/decision/account/request linkage, actual confirmed execution block separately from expiry bounds, and historical unknown attribution explicitly.
- Label stored receipt-backed DEFEND evidence separately from venue-reconciled closes. Do not fabricate a transaction proof from an admission deadline, rounded uptime, simulated P&L or a manually inserted LIVE strategy row.
- Refuse PAPER start/resume when the worker is disabled. LIVE GRID/market-maker admission stays blocked.

This is fail-closed hardening, not a guarantee of continuous availability. Reconciliation may remain unresolved when evidence is unavailable; a reference persisted before a crash is intentionally not retried blindly.

## Export and check evidence

Use an authorized **read-only** database connection and an exact UTC window/Book ID. The report performs SELECTs; it does not arm, submit or reconcile actions. Example from the repo root, after privately configuring the read-only connection and correct explorer/environment in the local `.env`:

```sh
node --env-file-if-exists=.env --import tsx scripts/report.ts \
  --from 2026-10-11T00:00:00Z --to 2026-10-11T01:00:00Z \
  --book YOUR_BOOK_UUID --out reports/perpl-bounty-run.md
```

Replace that example window with the actual run. `EYELER_ENV` and explorer configuration are operator-supplied labels, not network attestation. Do not publish credentials, connection strings, API keys, session tokens, private keys or PRF/passkey material.

For each claimed automated action:

1. Require a linked queue event with explicit `AUTOMATION` origin; older unattributed or conflicting records do not qualify. Preserve the queue event ID/time, decision, action, Book, account, market and request ID.
2. Require a terminal confirmed outcome, then match the live account/position change to the exact attempted action. Pending/UNKNOWN/PARTIAL, order admission and deadline expiry are not execution proof.
3. Independently inspect the real transaction receipt, status, network, destination and relevant operation/log identity using a trusted RPC/explorer. A stored hash/block is only a lead; canonicality and operation semantics still need checking. A close confirmed through signed venue/position evidence without a linked hash must not be advertised as receipt-backed.
4. Retain before/after exposure, defense reserve used, fees/funding where available, refusal/recovery events and the deployed candidate SHA. Reports show current configuration at export, not historical consent; preserve the reviewed configuration separately.
5. Read heartbeat coverage as bounds for recorded monitor samples, not tick-level continuous uptime. Financially incomplete net realized P&L stays unavailable, not zero; unrealized P&L is not realized profit.

The narrower `STORED_RECEIPT_BACKED` label requires a confirmed DEFEND, matching account/reference/progress request identity, transaction hash and actual confirmed block. It still does not independently reverify a receipt. The app displays stored evidence with this limitation and does not link expiry deadlines as execution blocks.

## Profitability evidence: do not cherry-pick

Reproduce the committed offline evaluation without venue credentials:

```sh
node --import tsx scripts/strategies-evaluate.ts
```

This writes ignored `reports/strategies/sensitivity.json`. The [evaluation notes](../strategies/evidence.md) include the fixture hash, capture sources, training/holdout split, funding semantics and hypothetical fill assumptions. Selected winner is null. Grid holdout results change sign across execution stresses; all evaluated maker holdouts lose. These are simulation results per 1,000 hypothetical AUSD, not live profits and not transferable to a 2-AUSD position.

Do not enable LIVE GRID or market maker to complete the submission. Their controller, ownership-aware cancellation, financial settlement/capital release and exact funding attribution remain unmounted. A 24-hour forward paper run and a longer independently evaluated horizon also remain unproved. The Book protection bot does not create entry alpha or guarantee it can recover losses.

## Two-minute real demo

Do account setup and consent review beforehand; edit only to shorten waiting, not to substitute simulation or conceal failures. Use one wallet/account/Book and show the deployment/network label.

| Time | Show | Judge-visible proof |
| --- | --- | --- |
| 0–20s | EYELER and the live protected position | Account/market, real position, AUSD collateral vs wallet balance |
| 20–45s | Reviewed Book limits and explicit arm | Floor, cap, reserve, stance, expiry, opt-in and pause/kill controls |
| 45–80s | Monitor decision → submitted → verified | Reason, freshness, bounded automatic action, no manual button passed off as automation |
| 80–105s | Autopsy, before/after position and real evidence | Exact action/request/account and independently checked receipt or accurately labeled venue evidence |
| 105–120s | Pause/kill and run report | Controls prevent new automation; result and limitations stated plainly |

A real safety trigger is not guaranteed to occur during filming. Capture a separately authorized natural/reviewed run first; if only replaying it, label the replay and retain the original timestamp/evidence. Never manufacture a trigger with unsafe leverage, manipulate market data, quietly increase capital, or weaken execution checks for a video. An expired Book can immediately request EXIT when armed; inspect current limits and expiry before consenting. Pause does not undo a request already transmitted.

## Local validation checkpoint — 2026-10-11

Verified against the final candidate source in the Downloads checkout before commit packaging. No application source edits followed the final full backend run.

- `npm run format:check`, `npm run typecheck`, `npm run build` and `npm run smoke:prod`: passed. `npm run lint`: exit 0, with five pre-existing warnings in the vendor passkey bundle and strategy receipt test.
- `npm test -- --maxWorkers=2 --testTimeout=20000 --hookTimeout=30000`: **840 tests passed in 140 files**, no skips, 586.80 seconds. The initial default-budget run hit resource-sensitive timeouts during concurrent builds and exposed a legacy-finalization regression, which was corrected. Test-only CLI budgets are disclosed; production/order deadlines and repository test definitions were not widened. Exact-commit CI with its standard budgets remains unverified.
- Flutter analyze: no issues. Dart formatting: 125 files, no changes. Final full Flutter suite: **304 tests passed**.
- Mainnet-profile release JavaScript web build: passed. Mainnet-profile Android **debug** APK: compiled successfully; no phone installation was performed. The artifacts identify the uncommitted candidate, not a deployed new backend.
- Android signed release: unavailable in this checkout because the existing signing configuration/material was not supplied. No replacement key was generated. Recover the existing release identity and verify association before distributing the passkey release.

All execution and database tests in this checkpoint are offline fixtures. No production deployment, real order, real receipt verification, sustained forward run or live net-profit result was obtained here.

## Release checklist and stop conditions

- [ ] Candidate lint, formatting, typecheck, backend build/smoke/full tests and Flutter analyze/format/tests pass; build release web and Android with the existing release identity before publishing.
- [ ] Exact candidate deployment/CI and `/ready` checked; correct per-user environment, credential profile, scope, account binding and one monitor owner. A public launch requires its KMS-backed profile and separate operational/security review.
- [ ] User separately approves the real account, bounded capital/loss limit, current Book parameters/time limit and automation. No real trade or arming is authorized by this code-audit task.
- [ ] Observe actual automatic action and restart/no-resend behavior without risking unrelated positions; stop on stale telemetry, uncertain account identity, exhausted reserve or unresolved execution.
- [ ] Independently verify and publish sanitized real evidence; disclose unavailable net profitability and coverage.
- [ ] Supply the working candidate link and ≤120-second video; confirm current organizer requirements before submission.

No production variable, deployment, funding, order or phone installation is changed by this audit. These release checkpoints require a separate authorized workflow. Passing local tests does not check these boxes automatically.
