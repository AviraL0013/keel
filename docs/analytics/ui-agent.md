# Analytics UI polish

## Scope and visual review

This branch refines the existing public Analytics screens. It keeps the current dark Eyeler layout, GET-only public route, polling, exact decimal touch values, and protocol-to-market-to-wallet navigation.

The protocol overview now shows observed volume sparklines, labeled chart bounds and local observation times, source and history coverage text, and numeric-aligned market columns. The market detail shows a proportional long/short open-interest bar, chart axes, funding units, source labels, and a direct wallet lookup action. The wallet and watchlist show two-column phone metrics, observed equity trend when an equity series exists, source and coverage text, and visible unavailable values. Screen readers can inspect chart points in order and hear the original decimal string with local time. A null chart point never becomes a zero.

Reviewed screenshot baselines are under `apps/mobile/test/analytics/goldens/` for Windows and `goldens/linux/` for Ubuntu. Updated views: protocol, market, wallet, and watchlist at 360 and 1280 dp, plus the 360 dp Analytics shell. The search baseline stayed byte-for-byte unchanged on Ubuntu. These baselines use the existing **illustrative sample fixture** for layout checks; they must not be described as live Perpl values. The chart accessibility test separately reads the recorded public mainnet BTC candles captured on 2026-10-07 in `apps/mobile/test/analytics/fixtures/perpl-mainnet-btc-2026-10-05.json`. The pinned Flutter version is 3.47.5. Only the already-reviewed protocol-1280 screenshot keeps its existing three-pixel tolerance; every other comparison remains exact.

## Remaining UI limits

- Market columns scroll horizontally on narrow phones. Values and headings stay aligned, but the full table cannot fit at 320 dp without suppressing columns.
- The existing illustrative screenshot fixture has no API provenance or coverage metadata. Its screenshot labels truthfully show source unavailable and coverage not reported. The HTTP repository fills those labels from real v1 envelopes when provided.
- Some nullable values have no field-level reason from the API. The UI shows `Unavailable` and says the reason was not supplied. It does not infer zero, liquidation prices, maintenance margin, or performance from another field.
- A full-screen screenshot replay using recorded mainnet v1 responses still needs a complete recorded response set. The existing public and wallet raw captures do not contain every dashboard endpoint at one observation boundary.

## API contract requests

1. Add machine-readable source, coverage interval, and unavailable reason for each nullable summary metric and chart series or bucket. The current response-level source can describe a mixed-source response only broadly; a free-text volume note is not enough for consistent labels.
2. Return the reason when market long share, funding, price, or liquidation data is null, including whether the cause is source omission, incomplete indexed history, or a failed observation. Preserve explicit nulls.
3. Expose finalized wallet maintenance margin as an exact decimal string when verified, or an explicit unavailable reason. The current public wallet margin contract supplies balance, locked, free, and equity but not maintenance margin.
4. Expose a verified liquidation price and its source or a specific unavailable reason for each position once the venue formula is proved. Until then, keep it null.
5. Give wallet equity and performance metrics field-level coverage and reason codes. A wallet can have a current finalized balance while position coverage and complete-history performance remain unavailable.

No API or backend contract was changed in this branch.

## Verification

- Flutter 3.47.5 on Ubuntu: all 291 mobile tests passed, including 128 analytics tests and exact Linux goldens. Full `flutter analyze --no-pub` reported no issues.
- Flutter 3.47.5 on Windows: all 10 analytics screenshot assertions and the fixed liquidation clock check passed without updating baselines. The existing 320, 360, 412, and 1280 dp loading, empty, error, stale, and loaded tests are part of the full suite.
- `flutter build web --release --no-pub` passed. It reported the existing secure-storage WebAssembly dry-run incompatibilities; the JavaScript web build succeeded.
- `flutter build apk --debug --no-pub` passed. Flutter reported the existing future Kotlin Gradle Plugin migration warning.
- `git diff --check` passed. The copied recorded BTC fixture has the same SHA-256 as its source in `packages/strategies/fixtures/`.
