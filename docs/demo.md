# Eyeler demo script

Show the public sandbox first (`EYELER_ENV=test`, `EYELER_TEST_VENUE=true`). Say plainly that its venue is deterministic and its outcomes are simulated. The app still uses the real HTTP, authentication, risk, policy, execution and Autopsy paths. Keep the live Perpl testnet proof separate.

1. **Sign in and open a Book.** Explain the reserve and cap. Automation is off until armed with consent. A fresh, healthy position yields **HOLD**.
2. **Cross the floor.** The checked-in scenario uses a BTC-PERP long, size 1, liquidation price 94, mark moving from 100 to 98, a 6% floor, 5 AUSD available, and a 2 AUSD defense cap. Liquidation distance at mark 98 is about **4.0816%**. The engine proposes **DEFEND 1.88 AUSD**. Show the reason and bounded amount before showing the action.
3. **Refuse an unaffordable defense.** Change the cap to 1 AUSD. The same state yields **REDUCE**, because the required 1.88 AUSD would exceed the cap. Show Autopsy evidence for the refusal.
4. **Lose freshness.** With telemetry age 20 seconds, the engine yields **SAFE_MODE** and sends no new order. Show the status and the recovery explanation.
5. **Show the live boundary.** On Perpl testnet, only call an action confirmed after the venue and account state reconcile. If outcome is UNKNOWN, explain that Eyeler waits and does not retry. Show a real action's admitted/response/block evidence in Autopsy when available.
6. **Show operational proof.** Open a one-hour Markdown run report generated with `npm run report -- --from <iso> --to <iso>`. It lists completed tick coverage, decisions, actions, SAFE_MODE intervals, retries and Telegram delivery. Treat it as evidence of this run, not as an exchange uptime claim.

`tests/demo-scenario.test.ts` runs the exact engine inputs for steps 1–4. The older blueprint example claiming a **63 AUSD DEFEND with a 100 AUSD cap** is not valid for its position: sizing needs about **140 AUSD**, so the engine refuses rescue and chooses REDUCE or EXIT. Do not use that claim in the demo.
