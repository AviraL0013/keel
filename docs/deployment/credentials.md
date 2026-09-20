# Credentials required for live activation

These values activate external services; none belong in mobile bundles. Current implementation limits are listed in `IMPLEMENTATION_STATUS.md`; credentials alone do not close those gaps.

## PERPL TESTNET — REQUIRED

- `PERPL_API_KEY` — public key identifier; server-only signed REST/trading WS access; testnet.
- `PERPL_API_KEY_SECRET` — secret Ed25519 seed; server secret; testnet.
- `PERPL_ACCOUNT_ID` — public Perpl account ID bound to wallet.
- Wallet transaction `allowOrderForwarding(true)` — external onchain approval; required for forwarded orders.
- `PERPL_REST_URL=https://testnet.perpl.xyz/api` — public endpoint.
- `PERPL_WS_URL=wss://testnet.perpl.xyz` — public endpoint.
- `PERPL_CHAIN_ID=10143` — public network value.

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

- `KEEL_ENV`, `PORT`, `CORS_ORIGIN` — deployment configuration.
- `KEEL_API_URL` — Flutter build-time API URL, passed with `--dart-define`.

No private wallet key is required by KEEL mobile. No withdrawal/transfer-out permission is requested from Perpl.

