# Agora mobile trading submission

Eyeler connects an Android Mera passkey wallet, Agora AUSD on Monad and owner-authorized Perpl trading. After opening a position, the user can create a Book with a liquidation-distance floor, defense reserve, cap and time limit. Automation requires an explicit choice.

## Reviewer access

- Trading system: <https://app.eyeler.xyz>.
- Signed Android APK: [Android release](https://github.com/AviraL0013/keel/releases/download/android-v1.0.0-45b214b/eyeler-android.apk). Follow the [installation and release-identity guide](../deployment/android-download.md).
- Public analytics: <https://app.eyeler.xyz/#/analytics>.
- Public reliability observations: <https://app.eyeler.xyz/#/status>.

Android installation is public; mainnet trading remains an allowlist demo. A new wallet may receive `WALLET_NOT_ALLOWED` until its public address is approved. Analytics and status need no sign-in. Android is the demonstrated native target; an iOS release is not demonstrated.

## Implemented journey

1. Create or recover a passkey using bundled official `@category-labs/mera` v0.2.0. An Android bridge delegates WebAuthn ceremonies to native Credential Manager. Flutter retains wallet derivation, screens and transaction signing.
2. Sign an app/network-bound, one-time wallet challenge. The backend verifies the wallet signature; passkey PRF output and private keys do not reach it. A new passkey creates a separate wallet rather than recovering an existing MetaMask address.
3. View the signed-in address, exact six-decimal AUSD wallet balance, MON gas balance and independently sourced Perpl collateral. Each source has its own network, observation and unavailable state. Wallet, Perpl and Book balances are not added together.
4. Activate Perpl with individually confirmed AUSD approval, account deposit and forwarding transactions. The activation journal checks receipts after interruption before offering another transaction. This is Perpl activation, not Agora issuer mint/redeem.
5. Review owner-bound enrollment for a read/trade key with no withdrawal permission and a zero builder-fee ceiling. Review account, market, size, direction, leverage, fees and bounded slippage before explicitly confirming an opening.
6. Wait for authoritative confirmation and inspect the resulting position. UNKNOWN or PARTIAL outcomes require reconciliation and do not permit blind resubmission.
7. Choose **Protect this position**, review Book limits and explicitly opt into automation. Pause and kill stop new automation; they do not undo a transmitted request.

Private-key export requires a fresh passkey assertion and verifies the derived address. Android screenshots are blocked while the key is displayed; matching clipboard content is cleared when the dialog closes. The user performs credential and biometric prompts. Recovery on one device does not prove provider cloud sync or backup recovery.

## Requirement and evidence map

- **Mobile Mera authentication:** official SDK bridge, derivation and connector tests; physical ceremony is recorded below. The final build recording and organizer acceptance remain separate.
- **AUSD and Perpl:** exact address-scoped balances, owner-bound enrollment, activation and opening tests. The final journey must show real AUSD and a confirmed trade with receipt/position linkage.
- **Integrated journey:** `agora-journey.test.ts`, onboarding and opening-flow tests cover evidence-derived steps and explicit Protect.
- **Bounded automation:** Book policy, shared capital admission, fresh telemetry and final authorization are implemented. Claiming live automation requires a separately reviewed real action.

Journey tests substitute chain, venue and activation transports. They prove application integration, not a physical ceremony or live trade.

## Recorded device and trading evidence

These are dated checkpoints, not fresh verification of the current deployment.

**October 11, 2026 — manual mainnet trade and Book.** Vivo V2036 ran signed build `0fd7d2d` with the release certificate matching live Asset Links. The existing allowlisted wallet was `0xce0FC5E5aB53903e74125bB26E3e89E211512da9`, Perpl account `5438`. The user approved a BTC LONG of `0.00001 BTC` at `1x`; Eyeler confirmed average fill `82759.5` and position `7364051271681`. Public transaction `0xd6487dd482ca69170a230b8a40d13ee8342a5b3803c628d254702a7b70b0bb1f` had receipt status `0x1` at block `0x6b293a9` when independently checked. The user created a Book with a `5%` floor, `0.50 AUSD` reserve/cap, `24h` and DEFEND. Automation was off; HOLD / `AUTOMATION_PAUSED` produced no automatic action.

**October 13, 2026 — official Mera SDK ceremony.** Vivo V2036 installed the 60.2 MB signed mainnet APK from local build `ee73baa`. The user created a Google-backed passkey through the official SDK bridge, completed fingerprint and derived `0x49fFA732546b81948d9b792A09a47A5e4FDdd455`. A fresh assertion allowed a private on-phone export; the user imported it privately into MetaMask and confirmed the same public address. Subsequent passkey sign-in recovered that address and returned the expected `WALLET_NOT_ALLOWED`. No funding, transaction or trade occurred. Temporary phone screenshots were deleted.

The checkpoints use different wallets and builds. They do not establish one continuous official-SDK-to-trade journey. The later public APK uses native source `45b214b987df5660bedaaa2499254e4c7ed6d19c`, package `xyz.eyeler.app`, version `1.0.0`, build `2`; the October 13 ceremony is not a device test of that later APK. The retained release certificate SHA-256 is `3B:5E:1E:84:90:F0:26:F8:09:5E:1B:F7:22:83:ED:AC:F2:25:3F:AF:2E:78:8E:F9:AA:4D:44:31:0E:F6:80:19`.

## Automation, custody and release proof

Grid and Market Maker now have an implemented LIVE controller alongside Book protection. LIVE is off by default and requires operator gates, owner-reviewed consent, a dedicated account and fresh risk admission. This does not establish a real automated mainnet fill or profit. See [Autopilot limits](../strategies/mainnet-autopilot.md) and [owner-reviewed evidence publication](../strategies/mainnet-evidence.md).

The allowlisted mainnet credential profile is separate from the KMS-backed public profile. It is not public-launch approval. Follow the [mainnet rollout](../deployment/mainnet-bounty.md), [credential guide](../deployment/credentials.md) and [KMS guide](../deployment/aws-kms.md).

The final video should show Android identity, passkey prompt, the same wallet with real AUSD, reviewed Perpl permissions, a confirmed order and explicit Protect. Keep it within two minutes and label replays. Retain candidate SHA, device/OS, package/certificate, network, account and public transaction references. Recheck deployed Asset Links and exact release identity before filming. Keep credentials, private keys, session tokens and PRF material out of recordings. A download, tests or HTTP 200 alone does not complete these release proofs.
