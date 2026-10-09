# Agora Onchain Trading Bounty Plan

## Acceptance target

Eyeler must provide an installed Android or iOS demo that signs the user in with a Mera passkey, displays a real exact-decimal AUSD balance from the Mera-derived address, and executes one Perpl trade only after that address is explicitly enrolled and Perpl approves the origin.

Perpl USD collateral, Perpl free and locked balances, Eyeler Book allocations, and Agora activity remain separate sources. No source is summed with another source.

## Identity decision

Mera passkey mode derives a new EVM address from WebAuthn PRF output. It cannot reproduce an existing MetaMask or Perpl address.

The operator selected a new Mera wallet only. Existing-wallet import, recovery-phrase entry, and Mera Vault mode are not part of this release. The already-funded external Perpl wallet is a separate account; its balance and credentials must never be assigned to the Mera wallet.

A new Mera address remains read-only until Perpl approves its origin and Eyeler has a per-user Perpl connection for that address. The server-wide Perpl account must never be used for an unrelated Mera address.

## Implemented build slices

- Capital: read Agora AUSD token separately from Perpl collateral. Use chain-specific token address, exact six-decimal formatting, source, freshness, and an explicit unavailable state.
- Mera: native Android passkey creation and PRF assertion adapter, with standard Mera EVM path (`m/44'/60'/0'/0/0`) derived client-side. Key material remains in the connector's in-memory signing session and is cleared on disposal/logout. The JavaScript Mera SDK is not bundled; a reference vector verifies derivation parity. iOS release/device support is not demonstrated.
- Auth: the credential ceremony runs on the device; the backend verifies a wallet signature over its one-time, wallet/network/app-bound challenge. It does not validate WebAuthn attestation or store passkey credential records. The server persists the user, wallet address and session only; PRF output and wallet private keys never reach it.
- Perpl binding: trading stays blocked until the Mera address has a matching, active read/trade connection and authenticated forwarding state. Owner-bound previews, explicit confirmations and existing bounded execution checks are reused without bypass.
- Demo mode: automated tests use fake external transports only. Mainnet code paths are implemented, but no live action is performed during development. A testnet USD demo alone must not be presented as real mainnet AUSD/Perpl evidence.

## Required external inputs

- Perpl approval for `https://app.eyeler.xyz`, testnet API enrollment, and exact Mera-derived address if separate-wallet mode is used.
- Agora confirmation that the installed Flutter Android Mera-compatible adapter satisfies bounty wording, including whether use of the JavaScript Mera SDK is mandatory and whether Monad testnet trading is accepted for judging.
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
- Android debug compilation in CI, locally signed Android release, backend tests, Flutter tests, lint, format, production/server typecheck, build, and smoke checks pass before deployment. Do not claim an iOS build or native device ceremony from the Android/web gates.

## Explicit non-goals

No Agora issuer mint/redeem API, token-transfer-out feature, custody of the user's Mera wallet, or Agora risk-policy input ships in this bounty slice. Perpl activation does include explicitly confirmed AUSD approval and deposit transactions into the Perpl Exchange; those are not Agora issuer mint/redeem operations. See [the submission evidence map](../product/agora-submission.md) for implementation proof and live release gates.
