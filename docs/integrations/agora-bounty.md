# Agora Onchain Trading Bounty Plan

## Acceptance target

Eyeler must provide an installed Android or iOS demo that signs the user in with a Mera passkey, displays a real exact-decimal AUSD balance from the Mera-derived address, and executes one Perpl trade only after that address is explicitly enrolled and Perpl approves the origin.

Perpl USD collateral, Perpl free and locked balances, Eyeler Book allocations, and Agora activity remain separate sources. No source is summed with another source.

## Identity decision

Mera passkey mode derives a new EVM address from WebAuthn PRF output. It cannot reproduce an existing MetaMask or Perpl address.

The operator selected a new Mera wallet only. Existing-wallet import, recovery-phrase entry, and Mera Vault mode are not part of this release. The already-funded external Perpl wallet is a separate account; its balance and credentials must never be assigned to the Mera wallet.

A new Mera address remains read-only until Perpl approves its origin and Eyeler has a per-user Perpl connection for that address. The server-wide Perpl account must never be used for an unrelated Mera address.

## Build slices

- Capital: read Agora AUSD token separately from Perpl collateral. Use chain-specific token address, exact six-decimal formatting, source, freshness, and an explicit unavailable state.
- Mera: add a native passkey/PRF adapter for Android first, then iOS. Derive standard Mera EVM path (`m/44'/60'/0'/0/0`) client-side. Keep key material in a short-lived signing session and zero it on lock/logout.
- Auth: add WebAuthn/Mera registration and assertion flow. Store only credential public data and application user ID. Never store PRF output or private keys server-side.
- Perpl binding: keep trading blocked until Mera address has matching Perpl connection and origin approval. Reuse existing bounded action and confirmation paths after binding; add no bypass.
- Demo mode: testnet only, fake venue in automated tests, no live action during development.

## Required external inputs

- Perpl approval for `https://app.eyeler.xyz`, testnet API enrollment, and exact Mera-derived address if separate-wallet mode is used.
- Agora confirmation that installed Flutter Android/iOS builds satisfy bounty wording and whether Monad testnet trade is accepted for judging.
- Android release package ID and signing certificate SHA-256 for Digital Asset Links, or iOS bundle ID and Apple Team ID for associated domain.
- Physical Android/iOS device or configured emulator with passkey support.
- User performs local passkey creation, AUSD faucet/deposit to the new address, and wallet confirmation. No seed, key, token, or signature is sent to Eyeler support.
- Operator configures [AWS KMS custody](../deployment/aws-kms.md), role authentication and audit retention before any deployed per-user trading.

## Test gates

- Mera PRF output deterministically reproduces same address and differs for a different passkey.
- PRF output, mnemonic, seed, and private key never appear in HTTP requests, logs, storage snapshots, or crash text.
- AUSD reads use signed-in address, exact decimal strings, correct testnet/mainnet token, and independent unavailable state.
- An unbound Mera address cannot create Books, arm automation, or submit actions.
- A bound address uses existing read-only, manual, and bounded execution checks without risk-engine dependence on Agora metrics.
- Reconnect, logout, failed passkey, stale RPC, and Perpl outage fail closed.
- Android debug/release, iOS build, backend tests, Flutter tests, lint, format, typecheck, build, and smoke checks pass before deployment.

## Explicit non-goals

No Agora deposit, mint, redeem, transfer, custody, write scope, or risk-policy input ships in this bounty slice.
