# Public wallet position tools

`DashboardWalletTools(address: widget.address)` mounts Position insights, Stress my
wallet, and Live wallet watch. Import `dashboard_wallet_tools.dart` in
`dashboard_wallet.dart` and place the widget after the open positions card on
the Positions tab. This file is the integration handoff; `dashboard_wallet.dart`
is owned by another terminal and is intentionally not edited on this branch.

The wrapper reuses `dashboardWalletProvider` and
`dashboardWalletActivityProvider`. Existing `dashboardWallet.dart` passes
`profile.isLoading` to wallet KPIs and the positions skeleton. During live
watch refreshes, the dashboard owner should preserve the previous loaded
snapshot while loading (for example, use `profile.isLoading && wallet == null`
for these loading flags) so the page does not flash skeletons every 30 seconds.

## Data and limits

- Position insights use the current profile's verified positions and the
  30-day activity of accounts currently linked to the wallet. Partial activity
  coverage is shown as verified days; missing days are never extrapolated.
- Stress preview uses current size and valid mark from the verified wallet
  snapshot. For a selected market, each linear sensitivity is signed
  `size × mark × price-change-basis-points / 10,000`. Exact decimal/BigInt
  products are summed before display rounding. Other markets are held fixed.
  This is an estimated mark-to-market change, not a venue settlement or
  liquidation prediction. Fees, funding, execution, and position changes are
  excluded.
- Live watch compares successive verified snapshots only after the user starts
  it. Its feed is session-only. A size change is an observation between source
  blocks, not a trade count or proof of historical ownership. A missing
  position is labeled "no longer observed." Incomplete data or a monitoring
  gap resets the comparison baseline. A changed linked-account set clears the
  feed and starts a new baseline.

Both tools reject stale snapshots, missing marks, incomplete position
enumeration, invalid position values, mismatched wallets, and missing source
blocks. No backend or trading endpoints are called by these components.
