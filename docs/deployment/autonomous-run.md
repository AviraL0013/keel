# Autonomous testnet run

This harness is for a position the operator has already opened on Perpl. It never opens a position. It signs in, creates one Book, makes one manual DEFEND and one manual REDUCE, arms automation, records a 60–120 minute window, pauses, makes one manual EXIT, and writes the local run report. **Running it can submit real testnet orders.** This engineering change was tested only with fake APIs; no live run was started.

Create a private JSON config outside the repository, for example:

```json
{
  "apiUrl": "https://api.eyeler.xyz",
  "chainId": 10143,
  "perplRestUrl": "https://testnet.perpl.xyz/api",
  "perplWsUrl": "wss://testnet.perpl.xyz",
  "market": "ETH",
  "marketId": 32,
  "positionId": 123456789,
  "reserve": 5,
  "cap": 2,
  "liquidationFloorOffset": 0.2,
  "runMinutes": 60
}
```

Use the actual Perpl testnet URLs configured for that deployment. The harness rejects any chain other than 10143, mainnet-looking URLs, reserve above 5 AUSD, cap above 2 AUSD, and run lengths outside 60–120 minutes. It confirms `/health` identifies `testnet`, `/ready` is healthy, the bound position is open, Perpl free collateral covers the cap, and no visible Book on that position has an unresolved action. The server does not expose its configured chain ID or Perpl URLs through a read-only endpoint, so the harness can validate the config and reported environment but cannot independently compare those server settings. Verify deployment configuration before starting a live run.

Set `EYELER_OPERATOR_PRIVATE_KEY` in the process environment without placing it in the config file or command line. Then run:

```bash
node scripts/run/autonomous-run.mjs /path/to/run.json
```

The key is used only to sign the wallet challenge. The harness does not print it. Output is under ignored `runs/<id>/`: `state.json` for safe resume, `events.jsonl` with 60-second readiness and action samples, and `report.md`. The default report command is `node dist/scripts/report.js`, so build first and make the run database available to that process. To resume, pass the same config and `--resume <id>`. An uncertain POST is never repeated: the harness searches for a new action by ID, and stops if it cannot establish the outcome. An optional `restartCommand` is an array such as `['railway', 'restart', '--service', 'api']`; it runs at most once near the midpoint.

For `--dry-run`, point `apiUrl` at a `test` environment with the deterministic test venue and a working database so `/ready` can return 200. The public in-memory sandbox currently reports `DATABASE_NOT_CONFIGURED` from `/ready`, so it cannot pass this harness's readiness gate. Dry mode requires the server to report `test` and otherwise follows the full workflow. Fake-API tests cover the flow without sending network requests.

The harness stops on UNKNOWN/PARTIAL, a 401/403, lost readiness for two minutes, an unexpected Book safety state, reserve accounting violation, or a DEFEND above the configured cap. It does not retry action POSTs. The action list does not expose raw reduce-only order fields, so reduce-only enforcement remains a backend invariant rather than something this harness can verify independently. The Book API cannot edit the liquidation floor after creation. The harness records its initial floor (`distance - offset`), but DEFEND and REDUCE can change the distance before automation is armed; it cannot guarantee that a small later market move will cross that floor.
