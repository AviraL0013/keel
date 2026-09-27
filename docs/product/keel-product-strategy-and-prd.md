# KEEL — Product Strategy and Requirements

| Field | Value |
| --- | --- |
| Document status | Draft for product, design, engineering, security, and legal review |
| Version | 1.0 |
| As of | 27 September 2026 |
| Product | KEEL mobile risk operations for leveraged onchain positions |
| Initial venue | Perpl |
| Initial environment | Testnet validation; mainnet is a separate launch decision |
| Product owner | To be assigned |
| Decision authority | Founder/product lead, engineering lead, security lead, and legal/compliance counsel for their respective launch gates |

This document defines the intended product and its release standards. **“Current” means implemented in this repository; it does not mean production-ready.** “Planned” means a proposed requirement. A passed local test or one successful testnet trade is evidence for a narrow behavior, not evidence of broad reliability or regulatory clearance.

## 1. Executive decision

KEEL should become the mobile control room for a leveraged position after the trade opens. A user connects a Perpl account, selects an existing isolated position, sets a risk boundary and a limited reserve budget, and creates a **Book**. KEEL watches market and position state, explains risk in ordinary language, and can perform bounded DEFEND, REDUCE, or EXIT actions when explicitly authorized. It records what it requested, what Perpl reported, and what actually changed in the position before telling the user an action completed.

The initial product promise is **clearer control and verified execution**, not guaranteed loss prevention or higher returns. The phone should answer four questions quickly: “What is open?”, “What needs attention?”, “What can KEEL do within my limits?”, and “What happened after an action?” Details such as request IDs, reason codes, and venue receipts remain available when needed, but do not dominate the everyday interface.

Perpl is the first execution venue. Monad and AUSD provide capital context. Agora is a potential AUSD data and funding partner, with a staged integration plan below. These systems have different authority and accounting roles; KEEL must never imply that a wallet AUSD balance is automatically available as Perpl collateral or as a Book reserve.

**Recommended product sequence:** finish reliability and consumer comprehension around one venue; prove repeated testnet journeys; run security and legal review; then evaluate mainnet and deeper Agora funding workflows. This is a recommendation, not an approved launch plan.

## 2. Customer problem and product thesis

Leveraged position management does not end when an order fills. A user must monitor liquidation distance, funding, liquidity, collateral, and order outcome while market conditions change. Existing trading screens expose these inputs, but the user must combine them under pressure. A successful order acknowledgement can also look like a completed action even when the venue has not filled or settled it.

KEEL turns that ongoing task into a persistent Book with explicit limits:

- **Position:** one bound Perpl position, identified by account, market, and position ID.
- **Risk boundary:** minimum acceptable estimated liquidation distance and time limit.
- **Reserve policy:** available budget, maximum defense deployment, and prior defense results.
- **Authority:** manual actions by default; automation is a separate, explicit setting.
- **Evidence:** decisions, submissions, venue outcomes, position changes, and exceptions.

The core hypothesis is that users will trust and repeatedly use a product that makes position risk legible and makes every action auditable. Secondary hypotheses are that bounded automation can reduce delayed reactions and that AUSD capital context can simplify funding decisions. Both need user research and outcome evidence before becoming marketing claims.

### Primary customers and jobs

| Segment | Job to be done | Main concern | Initial product response |
| --- | --- | --- | --- |
| Active self-directed trader | Monitor a small number of leveraged positions away from desktop | Missing a fast risk change | Current Books, clear attention state, notifications, manual controls |
| Risk-conscious trader | Set limits before stress arrives | Spending more collateral than intended | Book floor, cap, reserve, time limit, deterministic policy |
| Experienced trader | Review exactly what executed | Ambiguous orders and hidden failure | Action timeline, venue reference, reconciliation, Autopsy |
| Newer leveraged trader | Understand consequences before acting | Technical terms and false confidence | Plain-language summaries, confirmation, visible limits, no completion claim before verification |

The first release targets users who already have a Perpl position and understand leveraged trading. KEEL does not need to become a full order-entry terminal before the post-trade control job works well.

## 3. Product principles

1. **Show economic truth.** “Submitted,” “accepted,” “open,” “partially filled,” and “completed” are different states. Completion requires venue and position reconciliation.
2. **User limits outrank convenience.** No manual or automated action bypasses freshness, cap, reserve, position binding, trade authority, kill switch, or venue readiness.
3. **Fail closed, explain precisely.** Stale or unavailable authority blocks new execution. The interface names the unavailable input where possible and continues reconciliation of already submitted actions.
4. **Manual and automatic authority stay separate.** Automation OFF prevents autonomous actions. A deliberate manual request receives its own backend policy evaluation.
5. **Capital sources stay separate.** Wallet AUSD, Perpl available collateral, Perpl locked collateral, and KEEL’s Book ledger are distinct balances until verified movement reconciles them.
6. **Consumer language first.** “Needs attention,” “Checking with Perpl,” and “Action completed” are primary labels. Detailed telemetry and codes live behind “More details.”
7. **One position, one clear control surface.** Current Books and History have distinct homes. Filters help find positions; they do not hide safety-paused Books by default.
8. **No silent retries of uncertain trading.** A lost acknowledgement never authorizes a second order. Reconciliation continues independently of SAFE_MODE.

## 4. Current product truth

The following assessment comes from [architecture](../architecture/overview.md), [security notes](../security.md), the [Flutter feature code](../../apps/mobile/lib/features), and the backend adapters. It is a code-level inventory, not a production certification.

| Capability | Current state | Important limit |
| --- | --- | --- |
| Wallet challenge, server session, Perpl connection | Implemented | Production credential custody and external security review remain launch work |
| Book creation from a bound Perpl position | Implemented | Requires valid, fresh position and market telemetry |
| Current and History Books with market/status filters | Implemented | Usability and scale with many Books need user testing |
| Liquidation floor, cap, reserve, time limit, stance | Implemented | Policy quality and consumer understanding need measurement |
| Deterministic HOLD/DEFEND/REDUCE/EXIT/SAFE_MODE decisions | Implemented | Automated trading requires separate activation and release gates |
| Explicit manual DEFEND, REDUCE, EXIT | Implemented with Perpl testnet evidence | Repeated multi-account and adverse-network evidence still needed |
| Durable actions, request IDs, venue reconciliation | Implemented | Unknown outcomes remain blocked until authoritative resolution |
| Pause, kill switch, manual-only recovery | Implemented | Recovery cannot clear an unresolved action |
| Capital screen | Implemented | KEEL aggregate Book capital currently reports unavailable where ledger aggregation is not complete |
| Monad wallet AUSD balance | Implemented as read-only context | Wallet amount is not Perpl collateral or spendable Book reserve by itself |
| Agora | Adapter for metrics, session, and transaction reads; optional metrics fetch | No consumer Agora funding flow, transfer, mint, redeem, or reserve settlement is shipped |
| Autopsy and in-app notifications | Implemented | Push delivery and notification effectiveness need end-to-end validation |

Do not treat [the archived implementation-status page](../implementation-status.md) as a live release dashboard; its test counts and environment notes predate current work. Release evidence should be generated for each candidate build.

## 5. Information architecture and consumer experience

Primary navigation remains **Books, Positions, Capital, Autopsy, Notifications, Settings**. The everyday path starts in Books. Technical codes should remain accessible for support and experienced users without defining the main experience.

### Books list

- **Current** shows Books whose positions still require management, including ACTIVE, PAUSED, and SAFE_MODE. Put safety-paused Books first.
- **History** shows closed Books. Preserve their action and Autopsy records.
- One **Filter** control offers market and status filters. Show active filter state and an easy reset.
- Card summary shows market, side, plain status, unrealized P&L, automation setting, and last update. Show stale or unknown data as such; do not present a stale numeric value as live.
- If multiple Books refer to the same venue position, explain which Book controls it and block conflicting execution.

### Book detail

Order information by user decision: current risk state, protection health, last action, available controls, and then “More details.” Show estimated liquidation distance alongside the user’s configured floor. Show reserve available and cap used together. Mark, bid/ask, funding, and depth may appear in details, with source freshness matching backend execution policy.

The last-action card must distinguish:

| Backend meaning | Primary copy | Available action |
| --- | --- | --- |
| No action | “No action in progress” | Actions allowed only if policy gates pass |
| Queued, validating, submitting, submitted, verifying | “Action in progress” | Block duplicate action |
| Unknown venue outcome | “Checking with Perpl” | Block new action; continue reconciliation |
| Partial fill | “Action needs review” | Block conflicting action; reconcile remaining position |
| Confirmed and reconciled | “Action completed” | Re-evaluate current Book and position |
| Failed, canceled, expired | “Action not completed” | Show specific reason and current eligibility |

Never describe an HTTP timeout or order admission as a completed trade. Never label a genuine policy rejection “server unavailable.”

### Capital

Display separate source cards for wallet AUSD, Perpl available/locked collateral, and KEEL Book ledger. Every amount needs asset, source, freshness, and availability. Do not sum values across sources when doing so would double-count capital. If ledger aggregation is unavailable, state “Unavailable,” not zero.

### Notifications and Autopsy

Notifications should answer “what changed, why it matters, what I can do.” Critical events include SAFE_MODE, stale authority, unresolved execution, confirmed execution, exhausted defense cap, and Book closure. Autopsy should provide an ordered, immutable account of decision, request, venue evidence, and resulting position. Technical detail is expandable and exportable in a later phase.

## 6. Core journeys and acceptance criteria

### Journey A — connect and create a Book

1. User connects wallet and proves ownership with a fresh challenge.
2. KEEL validates the Perpl connection and shows open positions from authenticated venue state.
3. User selects one position. KEEL shows side, size, market, account, and a clear “last updated” state.
4. User sets floor, reserve, defense cap, time limit, stance, and automation preference. Automation defaults OFF.
5. Review screen explains which actions are permitted and what capital is available at Perpl.
6. Backend verifies current position binding and telemetry again before creating the Book.

**Acceptance:** stale or invalid market/position state blocks creation with a specific reason. A Book never binds to a different position because a list refreshed between selection and submission.

### Journey B — manual action

1. User taps DEFEND, REDUCE, or EXIT and sees current position, approximate requested effect, relevant cap, and explicit confirmation.
2. Backend refreshes venue authority and applies action-specific policy. Automation OFF does not itself reject the explicit request.
3. Before transmission, KEEL persists the action and unique Perpl request ID.
4. Perpl acknowledgement moves action into checking; it does not complete the action.
5. KEEL reconciles order, fills, account events, and economic position state before reporting completion.

**Acceptance:** each tap creates at most one venue submission. Any policy rejection creates no Perpl order. Unknown outcome blocks repetition and remains visible across restart. DEFEND never exceeds reserve or cap. REDUCE and EXIT are reduce-only and cannot increase or reverse exposure.

### Journey C — automation

1. User explicitly enables automation on a valid Book after reading its bounded authority.
2. Backend evaluates fresh state in the risk loop and decides HOLD, DEFEND, REDUCE, EXIT, or SAFE_MODE.
3. Action must pass the same execution gates as a manual action. No user interface calculation grants trading authority.
4. User can pause automation or use the kill switch. Previously submitted actions continue reconciliation.

**Acceptance:** automation OFF produces no autonomous order. SAFE_MODE produces no new order. A confirmed action changes the Book ledger only once. After an uncertain action resolves, manual access may recover after fresh checks; automation stays OFF until explicitly enabled again.

### Journey D — history and support

1. Closed Book moves to History without losing evidence.
2. User opens its timeline to see decision, request, venue status, fills, reserve effect, and final position.
3. Support can correlate action ID, venue request ID, venue order/transaction ID, and timestamp without seeing credentials.

**Acceptance:** a closed Book is not shown as a current open position. An unresolved action is never silently erased or relabeled failed solely because a UI history page lacks an order.

## 7. Functional requirements

Priority definitions: **P0** is required before any broader live release; **P1** is required for a credible consumer launch; **P2** is expansion. “Current” describes code presence, not release approval.

| ID | Priority | Requirement | Acceptance evidence | State |
| --- | --- | --- | --- | --- |
| ID-01 | P0 | Bind each Book to an authenticated Perpl account and exact open position | Position ID, market ID, side, and account match on creation and action | Current |
| ID-02 | P0 | Enforce server-side, fresh market, position, funding, and depth authority | Stale/unknown source blocks new execution; UI shows same freshness | Current; broaden failure tests |
| ID-03 | P0 | Keep manual and automated authorization separate | Automation OFF blocks loop, valid explicit manual action can proceed | Current |
| ID-04 | P0 | Enforce reserve, defense cap, position, stance, time, pause, and kill constraints | Rejection is typed; no order emitted | Current |
| ID-05 | P0 | Persist unique request ID and action before venue send | Restart and concurrent submission tests; no reused ID | Current |
| ID-06 | P0 | Distinguish accepted/open/partial/filled/canceled/expired/failed/unknown | UI and ledger do not treat admission as fill | Current |
| ID-07 | P0 | Reconcile economic position before completion | Signed venue evidence, fill and position delta, idempotent settlement | Current; repeated live proof needed |
| ID-08 | P0 | Continue reconciliation under SAFE_MODE and after restart | Unknown action remains blocked; worker reconciles independently | Current |
| ID-09 | P0 | Maintain separate environment asset and contract configuration | Testnet collateral never labeled as mainnet AUSD by assumption | Current boundary; audit before launch |
| ID-10 | P0 | Keep secrets server-side with least-required scopes | No secrets in Flutter, logs, Autopsy, exports, or analytics | Current design; external review needed |
| ID-11 | P1 | Consumer-first Books, History, Filter, and detailed view | User can find an urgent Book and understand action state without codes | Current; usability validation needed |
| ID-12 | P1 | Explain unavailable balances and stale data | No false zero or false LIVE display | Current partial |
| ID-13 | P1 | Complete Book-level capital totals without double counting | Reconcile reserved, deployed, remaining against ledger | Planned |
| ID-14 | P1 | Deliver useful alerts, with user-controlled notification settings | Critical alert delivery and open-to-Book path measured | Current in-app; delivery validation planned |
| ID-15 | P1 | Onboarding, consent, and risk education in plain language | Users can explain automation scope and possible loss in testing | Planned |
| ID-16 | P2 | Export a user-readable Book activity record | Complete sequence with source references, no secret material | Planned |
| ID-17 | P2 | Add more venues only behind the same proof and policy contract | Venue parity suite passes before activation | Planned |

## 8. Execution and risk contract

### Authority boundary

Flutter displays state and requests action. Backend owns eligibility, sizing, persistence, order construction, and reconciliation. Perpl is authoritative for accepted orders, fills, account events, and current position. PostgreSQL stores KEEL’s Book policy and durable action history. The market stream and authenticated position snapshot provide freshness evidence. A read-only Agora metric cannot authorize a trade.

### Action state model

```text
QUEUED -> VALIDATING -> SUBMITTING -> SUBMITTED -> VERIFYING
                                                   |          |
                                                   |          +-> UNKNOWN -> later reconciliation
                                                   +-> CONFIRMED / PARTIAL / CANCELED / EXPIRED / FAILED
```

Submission can fail before a venue request; that is a pre-venue failure. A genuine ambiguous transport result remains UNKNOWN. `UNKNOWN` is not a retry instruction. A Book safety pause blocks new orders but does not block reconciliation. DEFEND settles reserve only after confirmed economic evidence. REDUCE and EXIT verify the remaining or closed position. Partial fills retain their partial status and must not be represented as full completion.

### Risk and safety invariants

- Position must be open, valid, and bound to the Book.
- Required source timestamps must be fresh by backend policy. Current default thresholds are 10 seconds for market, position, funding, and orderbook; any change requires evidence, not a convenience increase.
- Book must be active for new manual execution. Automation additionally requires its explicit enablement.
- Kill switch and pause block new actions. An unresolved action blocks conflicting actions against the same position.
- DEFEND is bounded by reserve, cap, stance, time limit, funding, spread, depth, volatility, and prior defense efficiency.
- REDUCE and EXIT must be reduce-only, with side and size taken from the current bound position.
- Venue connection, forwarding permission, trade scope, request-ID baseline, and account state must be valid before send.
- No order is submitted if any pre-send check fails. Do not add a generic force-execute escape hatch.

These requirements describe current intent. The precise executable policy lives in [risk engine](../../packages/risk-engine/src/index.ts), [execution worker](../../server/src/workers/execution-worker.ts), and [Perpl adapter](../../packages/perpl/src/live.ts). Product copy must be checked against those implementations before each release.

## 9. Perpl, Monad, AUSD, and Agora strategy

### Perpl: first venue and execution authority

Perpl provides authenticated account/position state, market streams, order submission, and venue history. API authentication, an exchange account, and order-forwarding permission are separate prerequisites for API trading. Mainnet and testnet have distinct chain IDs, contracts, and collateral assets. Perpl currently documents **AUSD on Monad mainnet** and a distinct **USD collateral token on testnet**; KEEL must label the active environment’s asset correctly. [Perpl API documentation](https://github.com/PerplFoundation/api-docs)

Perpl is not the user’s entire product experience. KEEL owns Book rules, explanation, durable orchestration, and user trust. Venue outages should degrade KEEL to read-only/blocked execution with honest status rather than synthetic live data.

### Monad and AUSD: source-of-funds context

The current Monad adapter reads wallet AUSD. The Capital screen must show wallet balance separately from Perpl available and locked collateral. Any future transfer or deposit journey must prove source wallet, destination account, chain, token address, decimals, transaction finality, and resulting Perpl balance before labeling funds available to a Book. Agora lists different Monad mainnet and testnet AUSD deployments; use environment-specific configuration. [Agora contract deployments](https://docs.agora.finance/developer/contract-deployments)

### Agora: staged integration, not a decorative badge

Agora’s current API exposes public AUSD supply metrics and authenticated organizational Accounts, Routes, and Transactions. Its monetary values are decimal strings and its responses carry a `Request-Id` for support tracing. These are integration capabilities, **not** proof that KEEL users can mint, redeem, bridge, or transfer through KEEL today. [Agora Public API](https://docs.agora.finance/api)

| Stage | User value | Product requirement | Gate |
| --- | --- | --- | --- |
| 0 — current | Correct wallet AUSD context | Read onchain wallet balance; preserve Perpl collateral separation | Asset/network labels correct |
| 1 — near term | Understand capital movement | Complete KEEL reserve ledger totals; reconcile wallet, deposit, Perpl collateral, and Book allocation as distinct states | No double counting; transaction proof |
| 2 — optional | AUSD transparency | Show public Agora metrics only if they answer a user question; never imply supply metrics change Book safety | Measured user value; graceful outage |
| 3 — partnership-dependent | Funding and settlement history | Explore authenticated Agora transactions/routes for eligible organizations | Agora access, contract terms, privacy, support, legal review |
| 4 — future | In-app funding route | Design deposit/mint/redeem or cross-chain movement only after explicit integration and custody model | End-to-end settlement, reversals, limits, and compliance approval |

Do not put Agora API keys or session tokens in Flutter. Do not use JavaScript floating-point numbers for AUSD ledger amounts. Do not treat an Agora transaction record as a Perpl collateral credit until Perpl and chain evidence reconcile it.

## 10. Trust, security, and operating model

### Customer consent and control

Before enabling automation, show what KEEL may do, when it may act, maximum reserve deployment, and how the user can pause or revoke authority. Manual action confirmation must name the action and bound position. EXIT deserves stronger confirmation because it can close exposure. A user can inspect action history and revoke or rotate venue credentials. Recovery from SAFE_MODE is explicit or narrowly automatic only after verified action outcome and fresh checks; it never re-enables automation silently.

### Security and privacy requirements

- Keep venue keys, wallet signatures, session secrets, and Agora credentials out of the app binary, API responses, analytics, and logs.
- Separate read authority, trade authority, and funding authority. KEEL must not assume one implies another.
- Protect owner-scoped Book and action APIs; rate-limit sensitive operations; retain an audit trail for control changes.
- Define retention, deletion, export, access, and incident processes before broad release.
- Complete independent security assessment of key custody, auth, order replay protection, contract interactions, and mobile storage.
- Obtain jurisdiction-specific legal and compliance review for custody, automated trading, consumer disclosures, and marketing. This document makes no legal determination.

### Reliability targets for launch planning

These are **proposed targets**, not current measured service levels.

| Target | Proposed definition | Required instrumentation |
| --- | --- | --- |
| No duplicate live orders | Zero duplicate venue submissions for one action ID or unresolved request ID | Durable action/rq correlation; incident alert |
| Truthful completion | 100% of “completed” UI states backed by verified economic reconciliation | Action-to-venue-to-position trace |
| Freshness integrity | Zero executions when required backend source is stale or unknown | Gate reason counters and source ages |
| Recovery | Worker resumes unresolved-action reconciliation after process restart without a new submit | Restart drills and action replay |
| Availability | Separate API health from execution readiness; measure both by environment | `/health`, `/ready`, WS lifecycle, DB health |
| Incident response | Runbook for Perpl outage, rate limit, missing acknowledgement, and chain/RPC delay | On-call ownership and drills |

The release dashboard should distinguish “API up” from “safe to trade.” A 503 readiness response is correct when venue authority is unavailable; the consumer screen should say why and retry reads without offering executable controls.

## 11. Measurement and learning

### North-star and guardrails

Proposed north-star: **weekly active managed positions with a complete, understandable outcome trail**. Count a position only when the user can see current risk, capital context, and all action outcomes. Do not optimize for number of trades or reserve spent.

| Metric | Definition | Why it matters |
| --- | --- | --- |
| Book activation | Eligible connected users who create a Book for a real open position | Onboarding usefulness |
| Safe action completion | Requested actions that reach confirmed economic outcome without duplicate submission | Core product trust |
| Unknown resolution time | Time from UNKNOWN to verified terminal or explicitly still unresolved state | Operational reliability |
| Stale-state block rate | New action requests blocked by source and age | Data quality and user friction |
| Reserve accuracy | Difference between KEEL ledger and authoritative venue/chain evidence | Capital trust |
| Attention comprehension | Users who can explain current status and next safe action in moderated tests | Consumer usability |
| Alert usefulness | Critical notifications opened and followed by informed action; user-reported noise | Signal quality |
| Support burden | Cases per 100 active Books, grouped by root cause | Product clarity and robustness |

Instrument events without storing credentials or unnecessary wallet data. Split metrics by environment, venue, market, action kind, manual/automatic origin, and outcome. Treat a successful testnet execution as engineering evidence, not product-market fit.

### Research plan

Run moderated usability sessions before launch with at least three experience levels. Test creating a Book, explaining floor/cap/reserve, distinguishing wallet from venue collateral, reading UNKNOWN and PARTIAL states, pausing automation, and finding a closed Book. Record task success and mistaken assumptions. Review anonymized support cases after each testnet cohort; do not change safety policy solely to reduce blocked-action counts.

## 12. Release plan and stage gates

The sequence below is proposed. Dates, staffing, and commercial commitments require a separate planning decision.

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| A — reliable testnet | Stable Perpl stream, durable action lifecycle, consumer status copy, repeated manual DEFEND/REDUCE/EXIT | Failure matrix passes; venue history and position reconcile; no unknown retry |
| B — controlled automation | One small Book per cohort with bounded automation and operational monitoring | Kill/pause, stale gate, restart, partial fill, rate limit, and duplicate drills pass |
| C — capital truth | Complete Book ledger aggregation and environment-correct AUSD/Perpl display | Reconciliation with chain and Perpl; no false availability or double count |
| D — consumer beta | Onboarding, notification tuning, support/incident tooling, accessibility and usability work | User comprehension, security review, legal review, documented response process |
| E — mainnet decision | Explicit go/no-go for limited release | All P0 requirements and external approvals; measured reliability against agreed targets |
| F — Agora expansion | Add only user-valuable data or authorized funding workflows | Partner access, economics, settlement proof, legal and security approval |

### Required failure matrix before broader live use

Test fresh/stale/unknown telemetry per source; position changed before send; unavailable trade scope or forwarding; request-ID conflict; delayed and lost acknowledgements; REST 429; WS disconnect and DNS failure; restart during submission; partial fill; canceled/expired/failed order; venue history collision; reserve cap exhaustion; duplicate manual tap; Book pause and kill; external position close; and concurrent Books for the same account and position. Assert **no order** for every pre-submission rejection and **no second order** for unresolved outcomes.

Every release candidate needs backend tests, typecheck, lint, build, Flutter tests/analyze, migration rehearsal, and read-only venue checks. Live order tests require a separate, bounded test plan with exact account, position, maximum loss, and stop condition. Do not run live tests automatically as part of CI.

## 13. Commercial and organizational choices

KEEL should earn trust before choosing a revenue model. Candidate models include a subscription for advanced monitoring, a clearly disclosed fee on verified execution, or business tooling for sophisticated operators. A fee model must never reward unnecessary trades, repeated defense, or hidden conversion. Pricing, builder fees, distribution agreements, and consumer eligibility remain open decisions requiring partner and legal review.

Accountability should be explicit:

| Function | Decision responsibility |
| --- | --- |
| Product | Customer problem, scope, copy, metrics, release recommendation |
| Design/research | Consumer comprehension, accessibility, action confirmation, usability evidence |
| Engineering | Policy implementation, venue adapters, data integrity, incident tooling |
| Security | Key custody, auth, adversarial tests, release security gate |
| Legal/compliance | Jurisdiction, disclosures, custody and automated-trading review |
| Support/operations | Incident runbooks, escalation, user communication, reconciliation cases |
| Partnerships | Perpl and Agora access, terms, change management |

No one function can waive the others’ P0 gates through a UI label or configuration switch.

## 14. Open decisions and explicit non-goals

### Decisions required

1. Which user segment and jurisdiction define first controlled beta?
2. What position size, reserve cap, and loss limit are acceptable for supervised testnet and later mainnet cohorts?
3. Should automation remain opt-in per Book only, or can a user set account-level defaults after testing?
4. What is the precise source of truth for Book-level unreserved capital and transfers between wallet, Perpl, and KEEL ledger?
5. Does Agora partnership give KEEL authorized access to any funding routes, or should launch remain read-only AUSD context?
6. What is support policy for a venue outcome that remains UNKNOWN beyond a defined investigation window?
7. Which notifications are critical, optional, or legally required, and what delivery provider is approved?
8. What evidence threshold and independent reviews authorize a mainnet pilot?

### Out of scope for first release

- Guaranteed liquidation prevention, profitable trading advice, or a promise to “save” every position.
- Direct in-app mint, redeem, bridge, or transfer of AUSD without an approved settlement and custody design.
- Using Agora public supply metrics as a trade signal.
- Multi-venue execution before Perpl lifecycle and reconciliation are stable.
- Silent order retry, force execution, or automatic recovery that re-enables automation.
- Hiding an unresolved action by deleting a Book, resetting local history, or declaring failure from an empty venue UI list alone.

## 15. References and maintenance

Repository sources: [README](../../README.md), [architecture](../architecture/overview.md), [security](../security.md), [risk engine](../../packages/risk-engine/src/index.ts), [Perpl trading client](../../packages/perpl/src/trading.ts), [Agora adapter](../../packages/chain/src/agora.ts), and [Flutter features](../../apps/mobile/lib/features). External product surfaces: [Perpl API documentation](https://github.com/PerplFoundation/api-docs), [Agora Public API](https://docs.agora.finance/api), and [Agora contract deployments](https://docs.agora.finance/developer/contract-deployments). External capabilities and addresses must be rechecked before implementation or launch.

Update this document when product authority, capital flow, action semantics, or launch scope changes. Keep release evidence, measured targets, and approved decisions in a separate dated release record rather than silently converting proposals in this document into claims of shipped behavior.
