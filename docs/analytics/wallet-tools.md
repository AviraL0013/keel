# Public wallet position tools

The public wallet page mounts `DashboardWalletTools(address: widget.address)`
after the open positions card on the Positions tab. The wrapper displays
Position insights, Stress my wallet, and Live wallet watch using the established
dark analytics design. Desktop layouts put controls and summaries beside results;
phone layouts stack them.

The wrapper reuses `dashboardWalletProvider` and
`dashboardWalletActivityProvider`. Wallet KPIs and open positions preserve the
previous loaded snapshot while live watch refreshes, using
`profile.isLoading && wallet == null` for loading states. Watch stays mounted
while scrolling within Positions, pauses when the app becomes inactive, and
stops when the tab or wallet page is removed.

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
blocks. The tools use existing read-only analytics providers and never submit
orders or call private trading endpoints.
