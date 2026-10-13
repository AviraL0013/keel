# Current-account activity

`GET /analytics/v1/wallets/:address/activity` reports the last 30 completed UTC days. The route first reads the wallet's current Perpl account IDs from the Exchange. It then counts distinct account IDs with a settled maker fill or non-liquidation position action in each daily rollup bucket. A day with no matching event is zero only when the Exchange rollup covers that entire day without block gaps. Other days remain null. `activeDays` is null until all 30 days are verified.

This is activity for **accounts linked to the address now**. It does not prove that the same address owned those accounts at each historical event. The count is neither a trade count nor a realized PnL figure. The chart and API expose this scope explicitly. If the rollup store fails or is disabled, the endpoint returns an unavailable reason and leaves the metric null rather than blocking the current wallet profile.
