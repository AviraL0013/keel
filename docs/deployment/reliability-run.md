# Seven-day mainnet reliability campaign

This campaign records a seven-day observation window for Eyeler on Monad mainnet. It does not start a Book, start a strategy, place a test trade, or enable LIVE Autopilot. Existing armed Books and existing running PAPER strategies remain under their existing controls unless a safety failure pauses them.

The campaign is available only when the deployed API uses PostgreSQL, the environment is mainnet, and `NODE_ENV` is `production`. Other environments do not start this campaign. Its schema migrations add observation tables without arming existing business state.

## Public evidence

- Dashboard: <https://app.eyeler.xyz/#/status>.
- JSON: `/status.json` on the mainnet API.
- Incident pagination: `/status/incidents.json`, using the returned cursor for subsequent pages.

The durable `run.startedAt` value is the exact campaign start. `run.endsAt` is seven days later. A process restart retains that original window and accumulated evidence. A completed campaign does not automatically create another campaign.

Before publishing a submission sentence, copy `run.startedAt` from the serving JSON endpoint. Do not substitute a planned deployment time. The existence of a report does not mean seven days have already completed.

Public responses contain only approved status fields, timestamps, counts, reason codes, and public explorer links. They exclude wallet addresses, credentials, raw diagnostic messages, private account identifiers, and credential envelopes.

## Mainnet restart schedule

The first scheduled restart becomes eligible ten minutes after campaign start. Each successful durable claim moves the next eligible restart forward by 24 hours. There are at most seven claims, all within the campaign window. Claims are transactional, so competing processes cannot claim the same due restart independently.

Each claim records a `scheduled_restart` event and an open injected-failure incident before the process closes. The restart callback is queued after the recorder poll completes, avoiding a shutdown that waits on its own poll. Shutdown uses the existing 30-second drain deadline. A nonzero process exit invokes the existing Railway `ON_FAILURE` policy; it does not rebuild the image or change Railway variables.

Recovery is not inferred from HTTP 200 alone. The report requires:

1. A recorded clean lock release from the old process.
2. A later lock acquisition by a different process.
3. Healthy worker telemetry: running worker, no recorded tick error, fresh tick, lock ownership, and ready venue authority.
4. No duplicate persisted execution identities in the campaign window.
5. Recovery within 180 seconds of the recorded restart injection.

A forced drain timeout cannot establish a clean handover. Missing release or recovery evidence remains unproved. A restart that does not prove recovery within the deadline pauses automation.

## Synthetic failure schedule

The isolated suite is eligible on the first recorder poll and then at intervals of at least six hours. It runs in application fixtures, not against real Perpl accounts or a live PostgreSQL service. No mainnet network failure is injected.

The seven scenarios are:

- Kill a child process after a fake send is durably recorded in a disposable local ledger, then exercise Book reconciliation after restart.
- Drop an in-memory WebSocket and exercise the real Perpl client state invalidation and submission guards.
- Make replay market and position observations stale, then exercise the real risk engine.
- Reject a synthetic RPC request baseline and verify that the real transport refuses allocation and send.
- Reject synthetic database reads and exercise the real runtime lease-loss handler.
- Run two real runtime instances against synthetic advisory-lock arbitration and verify one transport authority at a time.
- Delay synthetic final evidence after a partial fill and verify read-only recovery without a replacement action.

Every scenario additionally exercises the actual application guards for existing UNKNOWN and PARTIAL actions. Results measure duplicate-send prevention, unresolved-action resubmission prevention, fail-closed behavior, and recovery after the synthetic fault. Recovery timing starts at fault injection, excluding child startup. Synthetic transports suppress their telemetry events so they do not inflate real WebSocket connection counts.

These tests prove application behavior under isolated failures. They do not prove real PostgreSQL failover, real network reconnect latency, real exchange fills, profitability, or infrastructure durability. An `unavailable` result means verification could not complete; it is never a passing result. A measured failed invariant pauses mainnet automation.

## Availability and execution scope

Worker health is sampled every 15 seconds. The uptime percentage is sampled worker availability over the elapsed campaign window, not continuous external API uptime or Perpl uptime. Missing sample intervals remain unobserved. The public snapshot cache lasts at most five seconds; live tick-age and lock fields are refreshed separately.

Book decisions and actions are taken from existing durable records. Send counts represent pre-send admission attempts, not independently verified fills. Explorer links use stored receipt or execution-block evidence. Duplicate identity checks and UNKNOWN/PARTIAL fences run before automatic Book transmission.

PAPER order, fill, and fee statistics are explicitly simulated. If deployment inspection finds no armed Books or no running PAPER strategies, report those zero counts. Do not infer automatic execution evidence from an idle worker or start a strategy to populate the report.

Analytics coverage shows completed UTC days supported by contiguous stored rollup ranges, together with their observed bounds. This does not establish complete Exchange history or confirmed-head lag. Those missing proofs remain unavailable.

## Safety and alerts

Trading flag names and boolean states are recorded at campaign start. The recorder compares them before runtime startup, before automatic Book submission, and during polling. The campaign does not change trading-related Railway variables.

On a measured safety failure, runtime authority is revoked before draining. Mainnet armed Books are durably moved to SAFE_MODE with automation off, and running mainnet PAPER strategies are paused. The campaign does not cancel or flatten a position as a test, enable LIVE strategies, or automatically re-arm paused automation.

Telegram incident messages target only the campaign owner through an existing active owner link. The report exposes whether that link and bot are configured. Configuration does not prove message delivery. Missing linkage, rejected sends, and ambiguous delivery outcomes must remain explicit. Ambiguous Telegram outcomes are not automatically resent.

An independent watchdog checks outstanding recorder polls every second. If a coalesced poll remains outstanding for more than 30 seconds, the watchdog revokes in-memory authority even while its database promise remains unresolved. A worker that remains unhealthy for more than 180 seconds also pauses automation.

Database failures can prevent immediate durable incident recording and Telegram delivery. Authority is revoked first; incident recording, durable pause, and eligible alerts are best effort until storage becomes available again. Do not infer successful recovery from a missing incident or missing observation.

## Railway cost evidence

Read-only billing checks on October 13, 2026 at approximately 15:59 UTC found:

| Scope | Measurement window | Estimated daily usage | Seven-day projection |
|---|---|---:|---:|
| Mainnet API and its existing PostgreSQL service | October 13, 09:58:53–15:58:53 UTC | $0.1466 | $1.0262 |
| Mainnet API and its existing PostgreSQL service | Previous 24 hours ending October 13, 15:57:08 UTC | $0.1770 | $1.2389 |
| Entire workspace, including other services | October 13, 09:59:35–15:59:35 UTC | $0.2688 | $1.8818 |

Railway reported $4.3576 in remaining usage credit and 21 trial days remaining. At the measured workspace rate, credit runway was approximately 16.2 days. Seven days fit that snapshot's budget if consumption remains comparable; future traffic, other services, backfills, and resource spikes can reduce runway.

These estimates convert measured resource-minute integrals using [Railway's published resource rates](https://railway.com/pricing). They are projections, not invoice guarantees. The recorder adds no service or replica. Its incremental CPU and memory cost has not yet been measured separately. Ten megabytes of additional persistent storage would cost approximately $0.00036 over seven days at the published rate; storage cost alone is not the total recorder overhead.

Recheck the workspace credit and actual consumption during the campaign. The public status report is not a live Railway billing monitor.

## Submission wording

After verifying the serving report and copying its actual start time, use:

> Seven-day reliability run started [exact UTC start]; https://app.eyeler.xyz/#/status reports sampled mainnet worker health, lock handovers, Book activity, PAPER statistics, analytics bounds, incidents, and isolated synthetic failure tests.

Until the seven-day end is reached, describe the campaign as running. An idle or partially observed campaign does not establish successful unattended trading or profitability.
