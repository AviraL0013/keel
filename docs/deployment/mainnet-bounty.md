# Mainnet profile and rollout

Mainnet uses `https://app.eyeler.xyz` and direct API `https://api-mainnet-production-b042.up.railway.app`. Testnet operator/sandbox stay separate; see [deployment](deploy.md). This runbook authorizes no flag changes or transactions. Check current configuration before release; canary settings below are initial values, not today's deployment state.

## Pinned network and identity

| Item | Mainnet value |
| --- | --- |
| Perpl REST / WebSocket | `https://app.perpl.xyz/api` / `wss://app.perpl.xyz` |
| Monad chain / RPC / explorer | `143` / `https://rpc.monad.xyz` / `https://monadscan.com` |
| Exchange | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F` |
| AUSD | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals |
| Account-opening floor | `10.000000 AUSD`; read current venue minimum before acting |
| Android / Mera RP ID | `xyz.eyeler.app` / `app.eyeler.xyz` |
| Builder | ID `25`, fee ceiling `0` |

Verify the Mera-derived public address on the phone before authorized funding or allowlist changes. Each approval, account creation and forwarding transaction needs user confirmation. Mixed networks, changed Exchange/token, or uncertain prior transactions block progress.

## Mainnet configuration

Values belong in secure host settings, never Git, chat, logs or Flutter builds. Use a separate PostgreSQL database and one execution replica.

| Names | Setting or gate |
| --- | --- |
| `EYELER_ENV`, `EYELER_PERPL_ACCOUNT_MODE` | `mainnet`, `per-user` |
| `EYELER_ACCESS_MODE`, `EYELER_ALLOWED_WALLETS` | Demo: explicit `allowlist` and approved public wallet addresses only |
| `DATABASE_URL`, `SESSION_SECRET` | Separate mainnet database and independent random session secret |
| `CORS_ORIGIN`, `EYELER_APP_URL`, `PERPL_ENROLLMENT_ORIGIN` | `https://app.eyeler.xyz` |
| `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID` | Mainnet Perpl values above |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS` | Mainnet Monad/AUSD values above |
| `EYELER_BUILDER_ID`, `EYELER_MAX_BUILDER_FEE_PER_100K` | `25`, `0` |
| `EYELER_EXECUTION_DISABLED`, `EYELER_OPENING_ENABLED` | Initial canary: `true`, `false`; later trading activation is separate |
| `EYELER_STRATEGIES_ENABLED`, `EYELER_STRATEGIES_LIVE_ENABLED`, `EYELER_ANALYTICS_ENABLED` | Initial preparation: `false`; enablement needs its own reviewed proof |
| `EYELER_KEY_CUSTODY` | `railway-allowlist-demo` for the approved team demo; `aws-kms` for public mainnet |

Demo custody requires `EYELER_DEMO_CUSTODY_KEYS` (version-to-32-byte-key map) and `EYELER_DEMO_CUSTODY_ACTIVE_VERSION`. Public/operator modes and empty allowlists are rejected. Retain versions for rows/backups; demo custody has no KMS audit isolation.

Public mainnet requires [AWS KMS](aws-kms.md): `AWS_REGION`, immutable `EYELER_KMS_KEY_ARN`, optional `EYELER_KMS_DECRYPT_KEY_ARNS`, and startup probe. The standard SDK chain supports environment credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`) and supported workload identity. Secrets stay on the host. `AWS_ROLE_ARN` alone cannot authenticate; `AWS_WEB_IDENTITY_TOKEN_FILE` needs real identity support. Verify IAM, context denial, retained-key restore and CloudTrail.

Unset shared `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, `PERPL_ACCOUNT_ID`, development custody keys and testnet custody variables on mainnet. See [credentials](credentials.md) for scope and rotation.

## Preparation and release

Preview only:

```text
node scripts/deploy/prepare-mainnet-railway.mjs --service api-mainnet --environment production --project <Railway project UUID> --wallet <public Mera address>
```

Review service/database and public address. `--apply` requires configuration authorization. The helper rejects existing target names/shared credentials, sends generated secrets through stdin with `--skip-deploys`, and prints names only. It supplies no `DATABASE_URL`, deployment or trading authorization. Review partial state before retrying.

Follow [deployment gates](deploy.md#release-readiness-and-rollback): five-job CI, backup/migrations, one replica, lock handover, `/ready`, unchanged trading flags. Build web/Android with matching API, RP ID and SHA. Check [signing and Digital Asset Links](android-download.md) and user-operated passkeys. Never use a real trade as a check.

Separate trading activation needs reviewed ownership, enrolled access, forwarding state, capital/loss limits and fresh observations. Readiness is not consent. LIVE strategy flags alone prove no safe execution or profitability.

Rollback retains mainnet history and needed keys/KMS access. Restore compatible API/web versions; never use the testnet operator account. Review uncertain orders before database restore. Record evidence in [Perpl](../product/perpl-submission.md), [Agora](../product/agora-submission.md) and [reliability](reliability-run.md); packaging proves no current deployment.
