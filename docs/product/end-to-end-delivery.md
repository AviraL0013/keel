# Eyeler end-to-end delivery checklist

Baseline: `2adf3bd` on 2026-10-06. Implementation branch: `feat/multiuser-product`.

This is the release checklist, not a claim that the product is complete. Mark an item complete only with a named test or release observation. Code, local tests, CI, and live verification are separate evidence.

## Product scope and boundaries

- Android first, with the existing web app preserved. iOS follows platform build and device verification.
- Mera passkey login, exact AUSD wallet balance, individual Perpl connections, opening positions, DEFEND/REDUCE/EXIT, bounded opt-in automation, and individual Telegram alerts.
- Perpl builder ID 25 was supplied by the operator. Mainnet enrollment OPTIONS requests for `https://app.eyeler.xyz` returned 204 and the matching allow-origin header. This does not prove enrollment, key permissions, or a trade.
- Builder fee ceiling defaults to zero. No paid builder fee is added without an explicit product decision and wallet authorization.
- No live orders, action endpoints, Book creation, database changes, automation activation, or funding during implementation. All write-path verification uses isolated test fixtures and fake venues.
- No automatic mainnet switch. The existing live testnet service remains independent until a reviewed release handover.
- No Agora mint/redeem/transfer API or custody. The bounty permits viewing an AUSD balance; an institutional Agora API account is not needed to read an ERC-20 wallet balance.
- The operator chose **new Mera wallet only**. It is separate from the already-funded external wallet. Existing-wallet linking and seed import are out of scope. Browser EIP-1193 compatibility remains for the existing operator deployment.
- UNKNOWN and PARTIAL execution outcomes never authorize automatic resubmission.

## Verified starting point

| Area             | Existing implementation                                               | Gap                                                                                           |
| ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Sessions         | Wallet signature challenges and persisted sessions                    | Public registration policy, linked wallets, per-user resource lifetime and cache isolation    |
| Mera             | Native PRF derivation and message signing                             | Typed-data signing, recovery/cancel/device proof, Android association, lifecycle locking      |
| Perpl enrollment | Encrypted testnet enrollment foundation                               | Mainnet configuration, production key custody, UI, account discovery and runtime binding      |
| Perpl execution  | Shared server account; tested risk actions and durable reconciliation | Per-user venue ownership; opening trades; concurrent multi-account verification               |
| Capital          | Separate wallet, venue, Book and Agora sources                        | Work without a venue key; correctly bind all sources to the selected identity and environment |
| Telegram         | Durable delivery to one configured operator chat                      | Verified per-user link, routing, unlink, privacy and terminal delivery failures               |
| Android          | CI build                                                              | Install, platform passkey association, device ceremony and release signing evidence           |
| Deploy           | Railway/Vercel CI workflows                                           | Candidate release verification, staged activation and rollback evidence                       |

## 1. Identity and many-user access

- [ ] ID-01: Define one authenticated user per verified wallet. Preserve current sessions and historical Book ownership.
- [ ] ID-02: Make access policy explicit (allowlist versus reviewed public enrollment). Default remains restricted. Never silently turn an empty allowlist into public access.
- [ ] ID-03: Bind challenge to purpose, domain, chain/environment, wallet, nonce and expiry. Reject replay, mismatched identity and expired signatures.
- [ ] ID-04: Reject connection ownership claims for any address other than the authenticated wallet. No account reassignment or seed-import path.
- [ ] ID-05: Revoke/expire sessions, lock wallet keys on logout/background/session expiry, and invalidate all user-specific Flutter providers on identity changes.
- [ ] ID-06: Apply ownership to Books, actions, positions, balances, connections, devices, notifications and Telegram. Test two simultaneous users and forged resource IDs.
- [ ] ID-07: Add per-user request limits and connection limits. One abusive or disconnected account must not starve others.

Acceptance: user B cannot read, trade, receive alerts for, or bind user A's resources, including after reconnect, restart or cached screen restoration.

## 2. Mera and installed Android

- [ ] ME-01: Verify PRF salt and BIP-39/BIP-44 derivation against pinned upstream Mera vectors. Preserve derived addresses across versions.
- [ ] ME-02: Separate create-account and sign-in intent. Cancel/error must not silently create a new wallet.
- [ ] ME-03: Require user verification and PRF support; reject missing, malformed or wrong-length extension output.
- [ ] ME-04: Add EIP-712 signing for the reviewed Perpl enrollment payload. Compare signatures/digests with an independent EVM implementation.
- [ ] ME-05: Validate environment, EIP-712 domain, chain, wallet, permissions, expiry and builder fee before requesting a signature.
- [ ] ME-06: Keep PRF/private material out of persistent app data, HTTP, logs and crash text. Document managed-memory limitations honestly.
- [ ] ME-07: Preserve browser EIP-1193 sign-in and test web startup; no native-only code may break the web bundle.
- [ ] ME-08: Publish Android Digital Asset Links for the exact installed package and signing certificate. No invented fingerprint or empty association file.
- [ ] ME-09: Verify create/login/cancel/lock/recover on a physical Android device or PRF-capable emulator. Record build SHA and device/OS.
- [ ] ME-10: Build a signed release artifact; document installation and backup/recovery. Verify iOS on macOS separately before claiming iOS support.

## 3. Per-user Perpl enrollment and credentials

- [ ] PE-01: Derive all REST/WS/chain/token/explorer settings from one validated environment. Reject mixed mainnet/testnet configuration.
- [ ] PE-02: Expose a safe connection capability response with environment, builder ID, zero fee ceiling, availability and precise reason.
- [ ] PE-03: Implement the wallet-signed enrollment UI: connect, review permission/expiry/fee, sign, confirm and show connection status.
- [ ] PE-04: Validate the entire returned EIP-712 payload before showing it to the wallet. Validate enrollment response before storing it.
- [x] PE-05 (implementation): AWS KMS envelope custody binds user ID, credential ID and environment, with per-credential data keys, replacement-key rewrap, audit events, startup access checks, and no development fallback. Production activation still needs the external checks in [the KMS runbook](../deployment/aws-kms.md).
- [ ] PE-06: Discover the account ID from signed wallet state. Never trust an account ID supplied by the browser or substitute server account 642.
- [ ] PE-07: Persist verified connection/account/owner/environment binding. Reject cross-user or cross-environment reuse.
- [ ] PE-08: Handle expired, revoked, ambiguous-enrollment and disconnect states. Disconnect blocks new execution; unresolved prior actions retain an explicit reconciliation path.
- [ ] PE-09: Verify origin approval on each deployed enrollment origin. Mainnet approval does not automatically prove testnet approval or another origin.

PE-09 check on 2026-10-07: unsigned testnet enrollment-payload requests with origin `https://app.eyeler.xyz` returned HTTP 400 `Bad Request` both with builder ID 25 and zero fee ceiling and without either builder field. Equivalent mainnet request with builder ID 25 returned HTTP 200. No signature or enrollment was attempted. Testnet builder terms and origin approval remain unverified; the generic 400 does not identify which testnet rule failed. Versioned Railway-secret envelope custody has fake-key tests for testnet and the explicit mainnet per-user allowlist demo. Public mainnet access remains KMS-only.

## 4. Runtime isolation and execution

- [ ] RT-01: Resolve a venue per user and persisted Book binding, with no shared-account fallback.
- [ ] RT-02: Own sockets, request-ID allocation and snapshots per account/environment. Request serial continuity survives restart.
- [ ] RT-03: Start private venue sessions only under the worker lock. Standby remains healthy but cannot touch private venue state or tick.
- [ ] RT-04: Persist the connection binding used by every new Book/action. A changed current connection must not redirect an old action.
- [ ] RT-05: Preserve reconciliation across credential refresh, disconnect and restart. Never resubmit UNKNOWN/PARTIAL.
- [ ] RT-06: Preserve exact reserve accounting, fresh account balance checks, cap limits, reduce-only rules and lfr serial comparison.
- [ ] RT-07: Test multiple users/accounts concurrently, one disconnected account, restart and lock handover. Bound queue/socket growth.
- [ ] RT-08: Preserve the existing operator setup through an explicit single-owner compatibility path. No broad fallback accessible to public users.

## 5. Opening trades and managing positions

- [ ] TR-01: Add market selection and fresh bid/ask/size/price precision from Perpl metadata.
- [ ] TR-02: Add a deliberately small opening-order interface (marketable limit with an explicit slippage cap, long/short, exact size and collateral). No implicit leverage or amount.
- [ ] TR-03: Preview notional, collateral, fees, slippage bound, environment and account; require explicit confirmation.
- [ ] TR-04: Server revalidates authorization, active connection, funds, size/price ticks, order window and fresh market state. Forged previews cannot authorize orders.
- [ ] TR-05: Persist idempotency and request ID before send. Double taps, retries, timeouts and reconnects cannot create duplicate trades.
- [ ] TR-06: Track opening order through submission, verification, confirmed/failed/partial/unknown states using authoritative venue evidence.
- [ ] TR-07: Show the verified new position, then create a Book through existing policy gates. A trade is not a Book reserve credit.

Opening-trade branch evidence: `opening-market.test.ts`, `opening-http.test.ts`, `opening-preview.test.ts`, `opening-previews.test.ts`, `opening-confirm-gates.test.ts`, `opening-reserves.test.ts`, `opening-migration.test.ts`, `opening-reconciliation.test.ts`, `perpl-trading.test.ts`, `perpl-request-id.test.ts`, `perpl-user-venues.test.ts`, and Flutter `opening_flow_test.dart` cover metadata, freshness, exact preview math, owner/expiry binding, reserve boundaries, migration 017, durable request IDs, IOC flags, fake-socket submission, no-resend recovery, receipt-backed reconciliation, and Protect navigation. No live order or deployed testnet enrollment has been exercised. The branch is not a production release; items remain unchecked pending all gates and external enrollment confirmation.

- [ ] TR-08: Exercise DEFEND/REDUCE/EXIT for each scoped account, including late history, insufficient funds, external/manual position changes and stale snapshots.
- [ ] TR-09: Keep automation opt-in, limits explicit, pause/kill effective, and unresolved actions blocking. No opening-position automation in this release.

## 6. Agora / AUSD capital

- [ ] CA-01: Read exact AUSD `balanceOf` and token decimals for the verified wallet on the selected Monad network, independently of Perpl credentials.
- [ ] CA-02: Keep Agora AUSD, Perpl testnet USD, Perpl free/locked collateral and Book allocations distinct. Never sum them into one balance.
- [ ] CA-03: Show address, chain, token, explorer, source and observation freshness; unavailable is never zero.
- [ ] CA-04: Show reserve coverage only for Books bound to the same Perpl account. Exact boundaries use six-decimal money.
- [ ] CA-05: Preserve optional Agora activity privacy, pagination, evidence cross-check and support request IDs. Works without Agora credentials.
- [ ] CA-06: Keep public supply metrics optional, off by default, and absent from risk decisions.
- [ ] CA-07: Test network mismatch, RPC timeout, malformed/oversized integer, unknown decimals, wrong wallet and re-login with another user.

## 7. Telegram and in-app notifications

- [ ] TG-01: Create a short-lived, one-time link token from an authenticated session. Store only its hash.
- [ ] TG-02: Link through an explicit private-chat `/start` payload. Verify Telegram webhook secret, chat type, sender and update replay rules.
- [ ] TG-03: Show linked/unavailable state and allow unlink/relink. Never accept an arbitrary chat ID from the app.
- [ ] TG-04: Route each alert to its notification owner's verified chat. No fallback to the operator's chat for other users.
- [ ] TG-05: Preserve deduplication and ambiguous-send behavior; bound retries and handle blocked bot/invalid chat as terminal failures.
- [ ] TG-06: Stop queued sends after unlink; pin delivery recipient to prevent misrouting on relink. Do not send historical alerts from before linking.
- [ ] TG-07: Keep messages minimal: event, market, side and authenticated deep link. No balances, keys, session tokens or raw internal errors.
- [ ] TG-08: Verify two-user routing, spoofed webhook, expired/replayed link, group chat rejection, unsubscribe and rate limits with fake Telegram transport.
- [ ] TG-09: Operator configures webhook and a real user tests opt-in delivery. No unsolicited messages during development.

## 8. Product states and release operations

- [ ] UX-01: Complete onboarding states for login, wallet identities, no Perpl account, connection pending, no funds, no positions and no Telegram.
- [ ] UX-02: Environment/account always visible at transaction confirmation and Capital. Fix any remaining mainnet-as-testnet labels.
- [ ] UX-03: Test narrow Android screens, loading/empty/error/disabled states, text scaling, accessibility labels and background/resume.
- [ ] OP-01: Document exact server-only setting names, release migrations, key backup/rotation, logs and rollback. Never commit values.
- [ ] OP-02: Keep Railway single owner/standby handover, health/readiness and CI gate. Preserve independent sandbox with no real credentials.
- [ ] OP-03: Build web with explicit API URL/environment/SHA. Verify deployed JavaScript, startup, headers and actual alias SHA.
- [ ] OP-04: Run every repository gate before commits: lint, format, typecheck, build, production smoke, all Node tests, Flutter analyze/test; add web and Android builds for affected paths.
- [ ] OP-05: Test migrations against existing fixture data and retain rollback compatibility. No production database edits in development.
- [ ] OP-06: Run workload tests without external services and report tested account count/latency. Do not claim unlimited users.
- [ ] OP-07: Review dependencies, log redaction, session cookies, CORS/CSRF, authorization and abuse limits. Resolve applicable jurisdiction/access policy with the operator before public mainnet activation.
- [ ] OP-08: Push candidate branch and verify CI. Merge/deploy only after release gates and required operator checkpoints are satisfied.

## 9. Bounty acceptance and release evidence

- [ ] BO-01: Install the recorded Android build.
- [ ] BO-02: Record successful Mera passkey login, with the resulting wallet address visible.
- [ ] BO-03: Show that user's real AUSD balance and its chain/source; do not relabel Perpl USD as AUSD.
- [ ] BO-04: Have the user explicitly authorize one Perpl trade in the app. Development tooling never places the trade.
- [ ] BO-05: Record authoritative confirmation and resulting position; include the public evidence reference.
- [ ] BO-06: Record a video no longer than two minutes and describe what is implemented, external dependencies and tested environment.
- [ ] BO-07: Obtain judging clarification where needed: accepted network, interpretation of native Mera compatibility and linked-wallet journey. Unknown eligibility remains unverified, not assumed approved.

## Required operator checkpoints (do not request secrets in chat)

1. Identity choice resolved: new Mera wallet only. Funding/activation of that new Perpl account remains a user action; the existing external-wallet deposit is separate.
2. Public bot username confirmed by the operator: `@eyelerbot`. Set `TELEGRAM_BOT_USERNAME=eyelerbot` and set bot/webhook secrets directly in server settings if missing. A username does not prove token access or webhook delivery.
3. Provide the public Android release signing fingerprint, or authorize generating a dedicated release signing key stored outside git. Complete a real device passkey ceremony.
4. Create the AWS KMS key and least-privilege IAM role using [the KMS runbook](../deployment/aws-kms.md). Configure short-lived workload authentication, CloudTrail retention and backup/rotation access. The application cannot authenticate from a role ARN alone. No paid service is purchased automatically.
5. Review the candidate mainnet activation configuration and any access/jurisdiction policy before public trading. Existing testnet credentials are never repurposed as mainnet credentials.
6. User alone signs enrollment, funds wallets and places the release/demo trade. Those observations cannot be replaced by unit tests.

## Delivery order

1. Record this checklist and independent test harnesses.
2. Fix tenant isolation and establish explicit connection/account bindings.
3. Finish safe enrollment, Mera signing and account connection UI.
4. Finish independent AUSD capital and per-user Telegram.
5. Add opening trades on the same durable, bounded execution foundation.
6. Complete UI/device/integration checks, then release and bounty evidence at the operator checkpoints.

## Progress and evidence

2026-10-06: Baseline audit complete. Working tree initially clean. Product implementation has not yet passed release gates. Existing mainnet CORS preflight succeeded; current live backend remains testnet with a held worker lock. Missing repository paths encountered during discovery were corrected; no external access denial was bypassed.

2026-10-06 implementation progress (candidate branch, not deployed):

- Per-user connection/account ownership, Book binding and guarded venue routing are implemented. Migration fixtures cover existing Books, ownership conflicts and unresolved-action revocation. Credential renewal/reconciliation and account load testing remain open.
- Mera create/sign-in separation, standard derivation vectors, restricted Perpl typed-data signing, identity cache invalidation and connection UI are implemented. Actual Android passkey ceremony, signed release build and association remain unverified.
- Independent exact AUSD reads and wallet/network/token evidence are implemented. Telegram one-time linking, user-owned delivery, replay protection and unlink handling are implemented. No production webhook or message was sent.
- AWS KMS custody is implemented behind KeyCustody. Test-first failures were followed by passing encryption/context/tamper/rotation/audit/startup tests. No real KMS call, AWS resource change or production credential migration occurred.
- Full current Node suite passed 441 tests across 75 files before the additional two isolated rotation-maintenance tests, which also passed. Lint, format check, typecheck, build and isolated production smoke passed at that point. Final candidate gates must include any later changes.
- Flutter analysis, 83-test suite, additional Capital evidence widget test and explicit-API release web build passed before the KMS server changes. Existing web Wasm dry-run warnings remain; the JavaScript release build succeeded.
- Android debug build failed resolving `androidx.annotation:annotation:1.10.0` from Google Maven: `Permission denied: getsockopt`, followed by `No such host is known (dl.google.com)` in Flutter's retry. This is a recorded network/build-tool failure, not an installed-app pass. No certificate bypass or credential workaround was used.
- A five-second auth test timeout under concurrent builds did not reproduce in a later focused run or the full suite. The earlier draft rotation provider was discarded when the operator selected AWS KMS.
- Opening-position execution and its UI are still unimplemented. No trade, live action endpoint, Book creation, live database edit, merge or deploy was performed. The whole product and bounty demo are not complete.
- Final local gate update: lint, format check, typecheck, build and isolated production smoke passed after adding the rotation command. Flutter analyze passed (93.2 seconds), Dart formatting changed zero files, and all 84 Flutter tests passed. A test first reproduced a mainnet enrollment-recovery link pointing at testnet; the corrected environment-specific link passed its focused HTTP regression.

2026-10-06 restart continuation:

- The operator confirmed that AWS is not set up and requested fake/local KMS testing only. No real AWS calls are authorized for this continuation. The existing branch and uncommitted implementation survived the laptop restart.
- Added an in-memory KMS SDK transport and a two-user lifecycle test using the real envelope provider. It covers standby, separate user credentials, registry restart, dry-run rotation, replacement-key rotation, removal of old-key access, cross-user ciphertext substitution, audit redaction, and zeroed returned data keys. Real SDK sends and HTTP fetches are trapped. The five focused custody suites passed 11 tests.
- A test first exposed the missing expired-credential recovery path. A newly verified active credential can now reconcile historical actions only when user, wallet, environment, and account still match. It never changes the Book's original binding and cannot submit a new order. Revocation and an account change invalidate this access. Explicit Book reauthorization after credential renewal remains unfinished.
- An HTTP regression found that the global browser-session hook rejected Telegram webhooks before their secret could be authenticated. The webhook route now uses its own secret authentication; link management remains session-authenticated. The complete local link/webhook/status/replay/unlink flow passes without sending a Telegram message.
- Added exact-decimal opening preview calculations and six tests for lot/price precision, slippage rounding, leverage limits, freshness, minimum notional, caller identity substitution, and exact balance boundaries. These are estimates marked `PREVIEW_ONLY`; no request ID, execution authorization, order endpoint, or live order is created. In particular, a short limit price is a minimum sale price, not a maximum margin-spend guarantee. Durable submission, collateral admission, reconciliation, and opening UI remain required before enabling this feature.
- A sandboxed Vitest launch failed with Windows `spawn EPERM` before running a test. Elevated isolated execution succeeded; no permissions or script workaround was applied.
- Two additional regressions proved a lock-loss race: private sockets remained open until a pending tick or another user's initialization completed. Losing the worker lock now closes transport authority immediately; graceful shutdown still drains before releasing its lock. All standby, graceful-shutdown, user-venue and execution-recovery tests pass. A logger call type error and an unnecessary asynchronous wait in the first patch were corrected before the final run.
- Final resumed Node suite: **79 files / 455 tests passed**. Lint passed with four existing vendored-passkey warnings; format check, typecheck, build, and isolated production smoke (`/health` 200) passed. Refactoring the fake KMS fixture initially changed its synthetic request ID; the audit assertion was corrected, focused tests passed, and the complete suite was rerun successfully.
- Android debug build now passes after the restart (215.1 seconds), with explicit `https://api.eyeler.xyz`, `testnet`, and chain `10143` build settings. This supersedes the earlier Google Maven download failure. Kotlin migration, SDK XML and deprecated-plugin warnings remain. The APK is a testnet debug artifact, not a signed mainnet release.
- `adb devices -l` found no attached device, and `emulator -list-avds` found no configured virtual device. No app was installed or launched, and no passkey was created. Device testing and release association remain external checkpoints. Dart sources are unchanged since the previously passing Flutter analysis, 84 tests, and release web build.

2026-10-06 candidate and connection-capacity follow-up:

- Saved and pushed the accumulated implementation as `f0f2eac` on `feat/multiuser-product`. Public [CI run 157](https://github.com/AviraL0013/keel/actions/runs/37485718257) reports success for validate, Flutter, Android, container and secrets. `deploy_web` was skipped on this feature branch. This is candidate CI evidence, not a production deployment or device ceremony.
- Seven additional connection-lifecycle tests cover idle reclamation, in-flight requests, stale handles, closing sockets, shutdown failures (including failed initialization), and a 70-account burst. The initial tests reproduced four idle/handle failures and then a separate failed-initialization cleanup failure; all focused regressions passed after the fix.
- Cached private venues are reclaimed after two minutes without use, checked every 30 seconds and when capacity is needed. An in-flight operation prevents idle eviction. Completion starts a new idle period. Evicted handles cannot use their former transport or close a replacement. Lock loss still closes transport authority immediately.
- The 64-connection limit includes opening and closing transports. Failed closure retains its slot and blocks a replacement for that credential; it also remains a shutdown error. This deliberately reduces available capacity when closure cannot be proved rather than creating overlapping sessions.
- The local fake-venue load test admitted 64 of 70 concurrent synthetic accounts, deferred six, then admitted those six after idle reclamation. Peak sockets remained 64 and all sockets closed on shutdown. The measured burst plus cleanup took 331 ms in this run, excluding database fixture setup. This is a local PGlite/fake-transport measurement, not production throughput, KMS latency, or proof of fairness for long-running monitoring across more than 64 accounts.
- These changes do not enable a fake custody provider in a deployed server. Mainnet still requires KMS configuration and the startup canary. No real AWS call, Telegram delivery, live venue call, production database edit, merge, or deployment was made.
- Follow-up gates: all **462 Node tests across 79 files passed** (106.67 seconds), as did lint (the same four vendored-passkey warnings), formatting, typecheck, build, and the isolated production smoke test. Flutter sources are unchanged from the successful candidate CI run above. Opening execution/UI, explicit Book reauthorization, wider monitoring fairness, installed-device passkeys, and external release checkpoints remain unfinished.
