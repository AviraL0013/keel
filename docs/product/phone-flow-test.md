# Android phone acceptance script

This is a staged manual device procedure, not permission to install an APK, fund a wallet, activate Perpl or trade. The current task has not connected to or changed the phone. Complete the phone checkpoint before any device command. Financial steps below are deferred until rollout and real-run approval; they are tested against fake RPC and venues locally first.

## Build and identity record

Record the candidate Git SHA, Flutter/Dart versions, APK SHA-256, signing-certificate SHA-256, package, RP ID, API origin and environment. Package must be `xyz.eyeler.app`; RP ID must remain `app.eyeler.xyz`. The release certificate must be:

`3B:5E:1E:84:90:F0:26:F8:09:5E:1B:F7:22:83:ED:AC:F2:25:3F:AF:2E:78:8E:F9:AA:4D:44:31:0E:F6:80:19`

Use the existing keystore outside the repository at `C:/Users/lenovo/AppData/Local/Eyeler/signing/eyeler-bounty-release.p12`. Read its password from the existing local password file without printing it. Do not commit signing files or put password values in arguments, logs or chat. Confirm the operator's backup before producing an installable candidate; this task has not verified that backup. A debug APK does not have the release certificate and cannot prove this association.

Before installation, inspect the release certificate with `apksigner verify --print-certs`. Verify the live Asset Links response is HTTP 200, `application/json`, no redirect, same package and fingerprint, with both `delegate_permission/common.handle_all_urls` and `delegate_permission/common.get_login_creds`. Verify Google's checker as well. These are separate from the checked-in file tests; this procedure does not claim current live results.

Use one explicitly selected authorized USB device. `adb devices` must show `device`, not `unauthorized`. Do not uninstall, run `pm clear`, read account lists, or inspect other apps. Never change Play services or phone settings during this acceptance run. Redact email addresses/account names from logs or screenshots before retaining evidence.

## Checkpoint: passkey and read-only wallet flow

Ask the operator to connect/unlock the phone and authorize debugging. With their approval, install the verified release APK and open Eyeler. Stop if the app, certificate, origin or network differs from the recorded candidate.

1. If an Eyeler passkey already exists, choose **SIGN IN WITH PASSKEY**. Do not create or delete another passkey to work around a server error.
2. For a new wallet only, choose **CREATE NEW MERA WALLET**. The operator selects their intended credential provider and performs the fingerprint/screen-lock step. Never automate the biometric or extract PRF/recovery material.
3. Record whether creation succeeds, cancels cleanly, or shows the exact error. A passkey provider's save message alone does not prove completed wallet creation. If it fails, capture only Eyeler/passkey diagnostics with account names redacted; stop rather than repeat creation.
4. Review and explicitly sign only the displayed Eyeler session challenge. Confirm its wallet, origin and network. This is authentication, not a transaction or Perpl enrollment signature.
5. If sign-in returns `WALLET_NOT_ALLOWED`, record the public wallet address/error and stop. Do not edit the allowlist or switch to an operator/shared wallet. This requires a separately approved access change during rollout.
6. Open Receive. Compare the complete public address with the QR and copied address. Record only the public address. Verify the network label, MON gas balance, six-decimal AUSD balance and unavailable/low-balance warnings. No funding occurs.
7. Close/reopen Eyeler and recover the existing passkey. Confirm the same address. Cancel one recovery prompt and confirm controls become usable without creating another wallet. Do not erase app data to simulate restart.

Pass criteria: exact candidate identity, successful provider prompt, recoverable same wallet, authorized server session and truthful balances. Passkey derivation tests prove network-independent derivation for the same passkey/RP ID; the physical device ceremony and server access are still external proof.

## Fake activation and opening acceptance

Before real approval, use the existing offline tests:

- `mera_derivation_test.dart`, `mera_wallet_connector_test.dart`, `mera_transaction_test.dart`: derivation, provider outcomes, explicit transaction confirmation and signature vectors.
- `activation_coordinator_test.dart`, `perpl_activation_test.dart`: existing account/allowance/forwarding, minimum amounts, wrong chain/contracts, rejection/revert/drop/stuck states and restart without a repeated deposit.
- Existing opening endpoint and widget tests: preview/confirm, identity, exact money, stale data, idempotency, outcome evidence and explicit Protect.
- `android-assetlinks.test.ts`: both relations, package, fingerprint, hosting headers and manifest statement.

These tests do not prove a deployed mainnet account or real trade. They do not replace phone tests at 320/360 dp.

## Deferred financial phone flow

Do not perform this section until the KMS setup, merge/deploy and real-run checkpoints are separately approved and verified. The operator handles all wallet confirmations and funding.

1. Compare full Mera address before funding it with MON and AUSD. Existing MetaMask funds do not move automatically. Confirm displayed balances against unsigned chain reads.
2. Activate Perpl only if chain 143 and the official context match pinned Exchange/AUSD addresses. Review exact AUSD approval, exact deposit at or above the observed minimum, and forwarding separately. Every transaction needs its own confirmation and explorer receipt.
3. Restart mid-step and verify the pending receipt before offering another action. A dropped/unknown result stays blocked until proved. Never repeat a deposit because the screen timed out.
4. Enroll the Mera-owned account using the displayed EIP-712 payload, exact approved origin, builder 25 and fee ceiling zero. Review ownership, environment, forwarding, expiration and encrypted credential custody. No shared operator account is used.
5. Preview one explicitly sized opening, review environment/account/leverage/slippage/collateral/fees, then let the operator confirm with a fresh preview. A double tap must return one durable order. `UNKNOWN` or `PARTIAL` never causes an automatic resend.
6. Confirm verified position/evidence and use **Protect this position**. Review the existing Book setup/cap/reserve gates. A fill is never Book reserve credit; no Book is created automatically.
7. Test browser-wallet sign-in separately on the candidate web build. Android Mera changes must not replace the EIP-1193 web path.

For every step, retain candidate SHA, environment/account, exact visible result, public transaction hash when one exists, and a pass/fail/unverified result. Never retain passkey secrets, signatures, session tokens or credentials.
