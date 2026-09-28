# Credentials required for live activation

These values activate external services; none belong in mobile bundles. Current implementation limits are listed in [docs/implementation-status.md](../implementation-status.md); credentials alone do not close those gaps.

## PERPL TESTNET — REQUIRED

- `PERPL_API_KEY` — public key identifier; server-only signed REST/trading WS access; testnet.
- `PERPL_API_KEY_SECRET` — secret Ed25519 seed; server secret; testnet.
- `PERPL_ACCOUNT_ID` — public Perpl account ID bound to wallet.
- Wallet transaction `allowOrderForwarding(true)` — external onchain approval; required for forwarded orders.
- `PERPL_REST_URL=https://testnet.perpl.xyz/api` — public endpoint.
- `PERPL_WS_URL=wss://testnet.perpl.xyz` — public endpoint.
- `PERPL_CHAIN_ID=10143` — public network value.

Optional development/testnet per-user enrollment (backend foundation only; Books still use the server-wide key):

- `EYELER_KEY_ENCRYPTION_KEY` — 32-byte hex AES-256-GCM key. Setting this enables the enrollment endpoints outside mainnet; keep it server-side.
- `PERPL_ENROLLMENT_ORIGIN` — exact HTTPS origin allowlisted by Perpl for payload/enroll requests.
- `EYELER_KEY_TTL_DAYS` — enrolled key lifetime, default 90.
- `EYELER_EGRESS_CIDRS` — optional comma-separated CIDRs, at most four.
- `EYELER_BUILDER_ID` and `EYELER_MAX_BUILDER_FEE_PER_100K` — optional paired builder terms; both must be set together.

EYELER never revokes a key at Perpl. Disconnect shreds local credentials and directs the user to the Perpl key page for venue-side revocation. Mainnet enrollment is disabled until production custody exists.

## MONAD TESTNET — REQUIRED FOR LIVE EVIDENCE

- `MONAD_RPC_URL` — reachable RPC endpoint.
- `MONAD_CHAIN_ID=10143` — public network value.
- `MONAD_WALLET_ADDRESS` — public wallet address whose AUSD balance is displayed.

## AUSD — REQUIRED FOR BALANCE EVIDENCE

- `AUSD_TOKEN_ADDRESS` — public environment-specific token address.
- A funded wallet/account with supported collateral balance.

Perpl testnet currently uses its documented USD collateral token separately from Agora AUSD. Do not substitute addresses across environments.

## AGORA — OPTIONAL CAPITAL METRICS

- `AGORA_API_URL` — public metrics base URL; defaults to `https://api.agora.finance`.
- `AGORA_METRICS_ENABLED=true` — enables the runtime's public Agora metrics read.
- `AGORA_API_KEY` — optional server secret for authenticated Agora session/transaction APIs; not needed for the retail MVP metrics view.

## DATABASE — REQUIRED TO RUN PERSISTENT SERVICE

- `DATABASE_URL` — secret PostgreSQL connection string.
- `SESSION_SECRET` — random server-only session secret.

## PUSH — OPTIONAL

- `PUSH_PROVIDER` — provider name.
- `PUSH_API_KEY` — provider secret. In-app notifications work without it.

## DEPLOYMENT — REQUIRED BY HOST

- `EYELER_ENV`, `PORT` — deployment configuration.
- `EYELER_ALLOWED_WALLETS` — comma-separated wallets allowed to obtain sessions. Empty falls back to `MONAD_WALLET_ADDRESS`; with neither set, only `EYELER_ENV=test` permits sign-in.
- `CORS_ORIGIN` — explicit browser origins on testnet/mainnet; development/test accept any origin, with credentials enabled.
- `EYELER_SAFE_MODE_RESUME_TICKS` — consecutive fresh, venue-ready ticks needed to resume transient SAFE_MODE; default `5`.
- `EYELER_API_URL` — Flutter build-time API URL, passed with `--dart-define`.

No private wallet key is required by EYELER mobile. No withdrawal/transfer-out permission is requested from Perpl.
