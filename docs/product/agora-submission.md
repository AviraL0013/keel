# Agora mobile trading submission

EYELER joins Mera passkey wallet ownership, Agora AUSD on Monad, and Perpl trading in one Android journey. Its differentiator is what follows the trade: a Book gives a position a liquidation floor, a bounded defense budget and a time limit, with opt-in automation and an execution audit trail.

## Implemented journey

1. Create a Mera-compatible passkey wallet or recover the existing passkey. A new passkey creates a separate wallet; signing into EYELER uses a wallet signature over a one-time app/network challenge.
2. Home reads actual wallet and venue state. It shows the signed-in address, Agora AUSD wallet balance, independently sourced Perpl collateral, and the next action.
3. Receive MON/AUSD on Monad mainnet. Check the passkey provider's recovery settings before funding. The recovery screen can verify the same wallet on this device; it cannot certify cloud sync or backups.
4. Activate Perpl: approve the exact account-opening AUSD amount, create/deposit into the account, enroll a read/trade key with no withdrawal permission and a zero builder-fee ceiling, then enable forwarding. Each transaction is explicitly confirmed and journaled for receipt recovery.
5. Open a position only after the app verifies the account identity, forwarding and fresh available collateral. Review size, direction, leverage, fees and bounded slippage. Backend execution independently revalidates every order and records an idempotency key before submission.
6. Wait for authoritative order confirmation and inspect the resulting position. UNKNOWN/PARTIAL outcomes do not authorize another submission.
7. Protect the position with a Book. Automation remains an explicit choice, with reserve limits, pause/kill controls and optional personal Telegram alerts.

Restarting or resuming recomputes progress from evidence; there is no local checkbox that grants trading readiness. Mainnet AUSD and testnet USD are never added together. Missing or stale balances do not become zero. Failed wallet authentication leaves an allowlisted user's derived address visible for an access request, without recreating their passkey.

## Two-minute demonstration

| Time | Show | Evidence |
| --- | --- | --- |
| 0–20 seconds | Android Mera passkey sign-in | Credential ceremony and resulting wallet address |
| 20–40 seconds | Home and Capital | Actual AUSD amount, Monad mainnet, token/source, wallet identity and observation time |
| 40–65 seconds | Account activation/status | Explicit permissions, account identity, forwarding and collateral; do setup beforehand if confirmation waits are long |
| 65–100 seconds | One deliberate Perpl order | User-reviewed preview, explicit confirmation, authoritative confirmed outcome and resulting position |
| 100–120 seconds | Protect the position | Book floor, defense cap, time limit and clear automation choice |

Use one wallet throughout. Do not substitute a browser-extension login for the Android passkey requirement. Record only public wallet/transaction/order evidence; keep session tokens, PRF material and API credentials out of the video. A local test fixture is not proof of a live trade.

## Verification and remaining release evidence

### Requirement-to-evidence map

| Bounty requirement / criterion | Implemented path | Automated evidence | Live evidence still required |
| --- | --- | --- | --- |
| Mobile app with Mera passkey authentication | Native PRF credential creation/recovery, standard Mera derivation, network-bound wallet session | `mera_wallet_connector_test.dart`, `mera_derivation_test.dart`, `auth-hardening.test.ts` | Installed Android credential ceremony; organizer acceptance of the Flutter Mera-compatible adapter |
| Hold and display AUSD | Address-scoped exact six-decimal AUSD on Monad, Receive QR/address, independent collateral cards | `capital-independent.test.ts`, `capital-session-wallet.test.ts`, `capital_wallet_evidence_test.dart` | Real AUSD balance in the signed-in wallet, network and observation time visible |
| Execute trades through Perpl | Owner-bound read/trade-only enrollment, explicit activation, preview/confirm, durable idempotency and reconciliation | `perpl-enrollment.test.ts`, `activation_coordinator_test.dart`, `opening-confirm-gates.test.ts`, `opening-reconciliation.test.ts` | One user-authorized confirmed order and its resulting position |
| Integrated user journey | Evidence-derived Home guides funding, activation, collateral, trade, then Book protection | `onboarding_test.dart`, `agora-journey.test.ts` | Continuous phone recording using the same wallet throughout |
| Implementation quality and creative integration | Risk-bounded Books, opt-in automation, independently sourced capital, fail-closed unknown outcomes | Risk/Book/reserve/tenant-isolation suites, Android mainnet/testnet CI artifacts | Explain why AUSD-backed trading benefits from bounded post-trade protection |

`agora-journey.test.ts` joins the real authentication, capital formatting, enrollment, database and opening-order services through HTTP. It substitutes chain/Perpl transports and activation receipts, asserts that an unbound or non-forwarding wallet cannot trade, confirms exactly once, checks another wallet cannot inspect/confirm the order, and verifies logout. Its synthetic wallet is shared with the Flutter reference-derivation vector and must never be funded. This is automated integration proof, **not** a WebAuthn device ceremony or an actual trade.

### Signed Android handoff

Release signing follows [Flutter's Android signing configuration](https://docs.flutter.dev/deployment/android#sign-the-app). Configure an ignored `apps/mobile/android/key.properties` containing `storeFile`, `storePassword`, `keyAlias` and `keyPassword`; resolve relative keystore paths from `apps/mobile/android`. Alternatively set `EYELER_ANDROID_KEYSTORE_PATH`, `EYELER_ANDROID_STORE_PASSWORD`, `EYELER_ANDROID_KEY_ALIAS` and `EYELER_ANDROID_KEY_PASSWORD` in the local build environment. Environment values take precedence. Release builds fail when these inputs are missing; debug builds are unchanged. Do not create a replacement key for an already-associated release identity.

Build locally after installing the Android SDK and supplying the backed-up signing material:

```sh
cd apps/mobile
flutter build apk --release \
  --dart-define=EYELER_DEPLOYMENT=mainnet \
  --dart-define=EYELER_API_URL=https://api.eyeler.xyz \
  --dart-define=EYELER_BUILD_SHA=YOUR_COMMIT_SHA
```

Check the APK's actual signing certificate against the checked-in association file before installation. Do not distribute the APK for passkey testing until the deployed HTTPS association file serves the same certificate/package without redirects. The native Flutter adapter implements the [Mera reference derivation](https://docs.monad.xyz/guides/mera/react-native); it does not bundle the JavaScript Mera SDK. Obtain organizer confirmation if judging requires that specific SDK rather than compatible passkey-derived authentication. Android is the release target; an iOS release has not been demonstrated.

Regression coverage: `tests/auth-hardening.test.ts`, `tests/auth-domain.test.ts`, `tests/perpl-enrollment.test.ts`, and `apps/mobile/test/onboarding_test.dart`, plus the existing opening-order, activation-journal, passkey derivation and tenant-isolation suites. Authentication now limits challenge/verification requests, preserves challenges after invalid signatures, consumes valid challenges atomically, prefers an explicit bearer token over stale cookies, uses HTTPS-only cookies on both live networks, and supports owner-scoped all-device logout. Expiration/logout removes pushed wallet screens.

`EYELER_KEY_TTL_DAYS` must be 1–90. Leave `EYELER_EGRESS_CIDRS` unset: neither signer accepts an independently unverified CIDR serialization, and startup now reports this unsupported configuration immediately.

The existing GitHub workflow compiles both testnet and mainnet Android debug APKs. Those are compilation artifacts, not release-signing or device-passkey evidence. A real release APK must use the backed-up certificate matching `/.well-known/assetlinks.json`.

Before calling the submission live-verified:

- Install that signed Android build and verify the deployed association file and an actual PRF-capable create/sign-in/recovery ceremony.
- Configure the mainnet per-user backend and KMS workload access using [the rollout plan](../deployment/mainnet-bounty.md). Public registration remains a deliberate operator configuration; an allowlisted demo wallet must be added before login can complete.
- Have the user fund/view real AUSD and explicitly authorize the activation transactions, enrollment and demo trade. Record the resulting confirmation and position.
- Record build SHA, network, package/certificate, device/OS, public order/transaction references and the short demo URL in the submission.

Implementation and fake-venue tests do not establish bounty eligibility, mobile-device compatibility or a live order. No production deployment, wallet funding or trade is performed by development tooling.

Local audit on 2026-10-07: Flutter analysis and all 127 Flutter tests passed; all 507 backend tests across 90 files passed, including the combined journey regression. Production/server typecheck, build, format checks, production smoke, mainnet JavaScript web compilation and dependency audit passed (zero reported vulnerabilities). An additional root `tsc --noEmit` check exposed existing type errors in older test fixtures outside the production/server typecheck gate; do not describe that broader check as passing. This machine has no Android SDK or connected Android phone, so native compilation is delegated to the branch's Android CI jobs. The live association-file recheck could not complete because this machine's HTTPS trust chain rejected the connection; no TLS verification was disabled. Release signing, deployed association, workload KMS access, organizer adapter acceptance and a real AUSD/Perpl demonstration remain release gates.
