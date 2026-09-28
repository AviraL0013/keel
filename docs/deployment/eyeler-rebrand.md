# Eyeler rebrand rollout

Eyeler is the new product name. This release changes application copy, package names, the web manifest, and new integration labels. It does **not** reset or rename the existing PostgreSQL database. Keep the current `DATABASE_URL`, Book and action history, Perpl account, wallet configuration, and durable request-ID records.

## Compatibility window

- Backend configuration accepts the new `EYELER_*` variables and their previous `KEEL_*` counterparts. If both versions of one setting differ, startup fails instead of choosing a potentially unsafe environment. Set only the new names in a fresh deployment.
- Flutter build settings prefer `EYELER_*` and fall back to the prior `KEEL_*` defines. Rebuild the web app with the new names.
- New wallet challenges say Eyeler. An already-issued Keel challenge remains verifiable for its five-minute lifetime only when the stored message and wallet signature match. Existing server sessions remain valid. The server accepts the old session cookie during the transition and clears both names on logout.
- On the same web origin, Flutter moves a saved session token and wallet address from old storage keys to Eyeler keys. A new domain has separate browser storage, so users sign in again there. Never transport a session token in a redirect or query string.
- New Perpl enrollment requests use the `EYELER` label. Existing Perpl keys and stored connection rows retain their original labels and origins. Do not edit or re-enroll them as part of this rename. The client recognizes the previous `KEEL_LEDGER` API source when an older backend serves it.
- Before first public distribution, Android `applicationId`, namespace, and Kotlin package changed to `xyz.eyeler.app`. Unpublished builds with the former ID cannot update in place; reinstall those development builds. The manifest has only a launcher intent filter, so no deep-link host needs migration.

## Domain cutover, after acquiring eyeler.xyz

Keep the live testnet labeled as testnet. Suggested origins are `https://testnet.eyeler.xyz` for Flutter and `https://api.testnet.eyeler.xyz` for the backend; keep the apex domain for a landing page or explicit redirect. Configure HTTPS and routing before switching the app. Then set `CORS_ORIGIN`, `EYELER_APP_URL`, and the Flutter `EYELER_API_URL` build define to those exact origins. Update Telegram links through `EYELER_APP_URL`. Obtain Perpl approval for the new `PERPL_ENROLLMENT_ORIGIN` before enabling enrollment there; do not assume a key approved for an older origin remains usable from a new one.

Deploy one backend instance against the same database and run only the normal additive migrations. Verify `/health`, `/ready`, wallet sign-in, existing Books and action history, read-only Perpl state, and Telegram Book links. Do not submit an order to test branding. The new domain can serve the new Flutter build only after the backend and CORS origin are ready.

If rollback is needed, stop the single backend instance and deploy the previous image with the same database and original configuration. Restore the previous web build and origin routing. Do not restore an old database backup merely to undo branding: that could discard execution and reconciliation history. The compatibility aliases permit old deployment variables during the transition.

Rename the GitHub repository only after the code and domain cutover are verified, then update local remotes, CI links, and deployment references. Archived project history and historical Autopsy records continue to describe the name used at the time.
