# Local Perpl testnet run on Windows

This run uses one compiled backend, a local PostgreSQL 16 container, and a release Flutter web build. The scripts do not create Books, arm automation, or submit orders. Use only a testnet wallet and account. Keep `.env` at the repository root; it is gitignored. Do not put server credentials in Flutter build arguments.

## One-time setup

Install Node 22, Docker Desktop, Flutter, Python 3, and Chrome. Docker must be running. Set `EYELER_ALLOWED_WALLETS` to exactly one wallet and provide `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, `PERPL_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID` in `.env`. The local setup also needs `DATABASE_URL` for `eyeler` on `127.0.0.1:5432` and a random `SESSION_SECRET`. Do not share their values.

Use `EYELER_ENV=testnet`, `CORS_ORIGIN=http://localhost:8082`, and `EYELER_APP_URL=http://localhost:8082`. Set the Perpl REST and WebSocket testnet URLs and chain ID 10143. The web build uses Monad's public testnet RPC and [testnet explorer](https://github.com/monad-developers#testnet). Keep Perpl enrollment settings unset. Telegram's local HTTP Book link works only on this computer; production app links must use HTTPS.

Another container using port 5432 must be stopped first. The `eyeler-postgres` container binds only `127.0.0.1:5432` and keeps data in the `eyeler-postgres-data` named volume. Never remove the volume to restart the app.

## Start and inspect

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local/start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local/status.ps1
```

`start.ps1` starts PostgreSQL, builds the compiled backend and release web app, runs migrations, opens the backend in its own PowerShell window, serves the web build, and waits for `/health` and `/ready`. Use `-SkipWebBuild` only when the existing web build has the correct API and Monad settings. The API writes `logs/api.log`; the static server writes under `logs/`. These files are gitignored.

Open `http://localhost:8082/`. `/health` at `http://localhost:8787/health` checks HTTP; `/ready` at `http://localhost:8787/ready` also requires a fresh monitor tick, connected Perpl venue, and tick lock. A 503 is a stop signal for live testing. Check its `reason` and the backend window before using the app. Perpl key, account, or one-click-trading problems require venue-side correction.

## Stop

Press Ctrl+C in the backend PowerShell window first. Wait for `EYELER shutdown complete`, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local/stop.ps1
```

The stop script ends the web server and stops PostgreSQL. It keeps the named volume and does not force-kill the backend.

## One-hour report

After the run, record its UTC start and end times. The compiled read-only report command is:

```powershell
node --env-file=.env dist/scripts/report.js --from <UTC-start-ISO> --to <UTC-end-ISO> --out reports/<date>-one-hour-run.md
```

The `reports/` directory is gitignored. Review tick gaps, SAFE_MODE episodes, action outcomes, and Telegram deliveries before sharing the report.
