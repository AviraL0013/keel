# AWS KMS credential custody

This configuration belongs to the candidate multi-user release. It does not change the existing live operator deployment. Do not switch the production environment or repurpose testnet credentials while preparing KMS.

## Operator setup

Create a symmetric `ENCRYPT_DECRYPT` customer-managed KMS key and a least-privilege runtime IAM identity. Prefer a role with short-lived credentials and the backend's region. An IAM user's access keys can also authenticate through the standard AWS SDK environment provider. Enable automatic key-material rotation and retain the key for the lifetime of credentials and retained backups. The application does not create, disable, schedule deletion of, or administer keys.

Set these names through the backend host's secure configuration:

| Name                          | Purpose                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `EYELER_KEY_CUSTODY`          | Set to `aws-kms`.                                                             |
| `AWS_REGION`                  | The KMS key's AWS region.                                                     |
| `EYELER_KMS_KEY_ARN`          | Full immutable key ARN for new encryption. Aliases are rejected.              |
| `EYELER_KMS_DECRYPT_KEY_ARNS` | Optional comma-separated previous key ARNs in the same region, maximum eight. |

Use the standard AWS SDK credential provider chain; the application does not implement custom credential handling. IAM user credentials can be supplied through host secrets named `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; temporary credentials also require `AWS_SESSION_TOKEN`. The chain supports workload credentials and web identity (`AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`) where the host provides a valid identity. A role ARN alone is not authentication. A GitHub Actions identity cannot be reused as the continuously running Railway service's identity. Railway workload federation has not been verified for this installation. Verify the actual deployed identity and KMS context checks before activation. Never paste credentials, web identity tokens, or private material into chat or the repository.

Unset `EYELER_KEY_ENCRYPTION_KEY` and `KEEL_KEY_ENCRYPTION_KEY` for deployed testnet/mainnet. `DevelopmentKeyCustody` is accepted only in `development` or `test`. Public mainnet access requires valid KMS configuration. An explicit team-wallet allowlist demo may instead use `railway-allowlist-demo` with `EYELER_DEMO_CUSTODY_KEYS` and `EYELER_DEMO_CUSTODY_ACTIVE_VERSION`; it requires mainnet per-user accounts and `EYELER_ACCESS_MODE=allowlist`. Deployed per-user testnet supports either AWS KMS or the separate versioned `railway-testnet` provider documented in [credentials](credentials.md). There is no automatic fallback when KMS is unavailable.

## Minimum runtime IAM policy

Replace `KEY_ARN` privately with the operator-created key ARN. This identity policy can be attached to the runtime role or dedicated IAM user; it is not a complete KMS key policy or role trust policy. The key policy must permit that identity directly or through appropriate account IAM delegation. If using a role, restrict its trust policy to the actual workload identity and intended audience/subject.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EyelerCredentialEnvelope",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "KEY_ARN",
      "Condition": {
        "StringEquals": {
          "kms:EncryptionContext:application": "eyeler",
          "kms:EncryptionContext:environment": "mainnet",
          "kms:EncryptionContext:version": "1"
        },
        "StringLike": {
          "kms:EncryptionContext:userId": "?*",
          "kms:EncryptionContext:credentialId": "?*"
        },
        "ForAllValues:StringEquals": {
          "kms:EncryptionContextKeys": ["application", "environment", "userId", "credentialId", "version"]
        },
        "Null": {
          "kms:EncryptionContext:userId": "false",
          "kms:EncryptionContext:credentialId": "false"
        }
      }
    }
  ]
}
```

Use a separate testnet key/role with the environment condition set to `testnet`. During replacement-key rotation, grant only `kms:Decrypt` on retained old keys with the same context conditions. The normal runtime needs no `kms:*`, key administration, `ListKeys`, `DescribeKey`, `Encrypt`, grant creation, or rotation administration permission.

The shared runtime role can present any permitted user/credential context. KMS prevents ciphertext/context substitution; application authorization still owns the decision about which authenticated user may request a decrypt. Context binding is not a substitute for server ownership checks.

## Envelope and startup behavior

Every sealed private key, API token, or enrollment MAC gets a fresh KMS `GenerateDataKey(AES_256)` response and a random 96-bit AES-GCM nonce. Only the wrapped data key, immutable KMS key ARN, nonce, authentication tag, and ciphertext are persisted in the versioned `kms-v1` envelope. The credential itself is encrypted locally; it is not sent to KMS.

KMS encryption context and local AES-GCM additional authenticated data contain `application`, environment, database user ID, credential ID (`connection ID:field`), and format version. Decryption reconstructs context from the authorized database row, not from untrusted envelope metadata. There is no plaintext data-key cache. Returned key buffers and temporary plaintext buffers are overwritten in `finally`; JavaScript strings and cryptographic library internals cannot provide guaranteed physical memory erasure.

Before starting the worker, startup performs a GenerateDataKey/decrypt round trip with a nonsecret canary, user ID `startup-check`, and a unique `startup:<uuid>` credential ID. An absent role, denied permission, disabled/wrong key, invalid response, timeout, or audit callback failure aborts startup with `KMS_CUSTODY_UNAVAILABLE`. This requires working network access and incurs two KMS requests per startup. It performs no database write or venue action. SDK command retries are disabled; the application does not change providers or endpoints after denial.

## Rotation and rollback

Automatic KMS key-material rotation preserves the key ARN and existing wrapped data keys. No application ciphertext rewrite is required.

For replacement-key rotation, configure the new ARN for writes and retain old ARNs in `EYELER_KMS_DECRYPT_KEY_ARNS`. Both remain decryptable. `AwsKmsKeyCustody.rotate` rewraps the encrypted data key with KMS `ReEncrypt`, keeping the same user/credential/environment context and encrypted credential bytes. Give a separately controlled maintenance role `kms:ReEncryptFrom` only on source keys and `kms:ReEncryptTo` only on the destination key, with the same context conditions. The runtime does not perform automatic row rewrites.

The maintenance command defaults to read-only row enumeration:

```sh
node dist/scripts/rotate-perpl-credentials.js
```

Only an explicitly reviewed maintenance operation may add `--apply`. That mode rewraps active/pending credential rows in batches of 100 for the configured environment. Each row update compares its original ciphertext, owner, environment, status, and revocation state. It cannot restore a credential concurrently revoked or replaced. An error stops later work; previously completed rows remain rotated and readable through the retained-key configuration. No plaintext or envelope is printed. An in-progress `ENROLLING` row is excluded; rerun after it settles. No live rotation command has been run.

Do not remove old-key access while any database row or retained backup still needs it. Rollback must retain decrypt permissions for every key used by the newer build. KMS custody never decrypts legacy `v2`/development envelopes: migrate those in a separately reviewed maintenance operation or re-enroll, preserving unresolved execution history. No live migration has been run.

## Audit and verification

Each decrypt emits an attempt and a success/failure event with opaque user ID, credential ID, environment, allowed key ARN when known, and KMS request ID on success. No plaintext, wrapped data key, ciphertext, API token, wallet signature, or raw AWS error is logged. An audit callback failure prevents plaintext release. The default sink is structured backend logs; configure durable restricted log retention before launch. Application logs are not an immutable audit store.

Enable and verify CloudTrail KMS events and retention in AWS. Encryption context is visible in CloudTrail, so it contains only opaque identifiers, never secrets. Check both application and CloudTrail audit records during staging; a unit test cannot prove the AWS policy or retained cloud audit trail.

Local tests use a fake KMS client and isolated PostgreSQL/WASM fixtures. Required external proof: authentication through the deployed SDK provider chain, actual KMS round trip, denied-context decrypt, rotation/restore using nonproduction fixtures, CloudTrail delivery, then reviewed mainnet activation. Documentation and mocked tests do not establish those external checks.

### Work while AWS setup is pending

No AWS account, credentials, endpoint, or emulator is needed for the local custody tests:

```sh
node node_modules/vitest/vitest.mjs run --dir tests tests/perpl-kms-custody.test.ts tests/kms-user-lifecycle.test.ts tests/kms-startup.test.ts tests/key-custody-config.test.ts tests/credential-rotation.test.ts --maxWorkers=2
```

`tests/helpers/kms.ts` supplies an in-memory SDK transport. It models data-key generation, context-bound decrypt, and replacement-key rewrap using synthetic identifiers. The lifecycle test uses the real `AwsKmsKeyCustody` implementation and isolated database fixtures, restarts the user-venue registry, replaces the wrapping key, and rejects ciphertext copied between users. It also traps real SDK sends and HTTP fetches. This does not model AWS IAM enforcement, CloudTrail, key durability, or availability.

There is deliberately no `fake` custody configuration for a deployed server and no local KMS endpoint override. Public mainnet access requires `aws-kms` and a successful startup probe; the explicit team-wallet allowlist demo is the only mainnet exception. Development custody is permitted only for local development and test environments. Do not mark an AWS readiness checkpoint complete because the fake tests pass.

Keep key ARNs and identity configuration in private deployment settings. Report variable names and presence only; never print access keys, tokens, account-identifying ARNs, or private material. Configure SDK authentication through the host secret settings. Present variables alone do not prove authentication or authorize mainnet activation.

Sources: [GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html), [encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html), [ReEncrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_ReEncrypt.html), [key rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html), [SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html), [Railway OAuth](https://docs.railway.com/integrations/oauth).
