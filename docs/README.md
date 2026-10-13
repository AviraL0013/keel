# Eyeler documentation

Start with the submission guide for the feature you want to review. These guides separate implemented features, recorded demonstrations, and evidence that still requires verification.

## Submission guides

- [Agora mobile trading](product/agora-submission.md): official Mera passkeys, AUSD, Perpl trading, Android installation, and device evidence.
- [Perpl analytics and risk](product/analytics-submission.md): public protocol and wallet views, data sources, coverage, and limitations.
- [Best use of Perpl's API](product/perpl-submission.md): Book automation, Autopilot, execution safeguards, and activity evidence.
- [Android download and judge access](deployment/android-download.md).
- [Seven-day reliability report](deployment/reliability-run.md).

## Implementation and verification

- [Architecture](architecture/overview.md), [API](api/overview.md), and [analytics API contract](api/analytics-v1.md).
- [Development](development.md), [testing](testing.md), and [security](security.md).
- [Analytics metric definitions](analytics/metrics.md), [operations](analytics/operations.md), [recorded evidence](analytics/verification.md), and [wallet tools](analytics/wallet-tools.md).
- [Strategy overview](strategies/README.md), [simulation evidence](strategies/evidence.md), [mainnet execution](strategies/mainnet-autopilot.md), and [public evidence reports](strategies/mainnet-evidence.md).
- [Forwarded request identities](perpl-forwarded-request-ids.md) and [receipt provenance](strategies/order-proof.md).

## Deployment

- [Deployment guide](deployment/deploy.md) and [mainnet profile](deployment/mainnet-bounty.md).
- [Credentials](deployment/credentials.md) and [AWS KMS custody](deployment/aws-kms.md).

The retained [Perpl API reference](vendor/perpl-api-docs/README.md) documents the wire definitions cited by the adapter. Runnable upstream examples are linked from the official repository rather than duplicated here.

Historical agent handoffs, implementation trackers, and duplicate plans are available in Git history. They are not the current submission guide. Recorded values and screenshots retain their observation dates; they are not a live service-status claim.
