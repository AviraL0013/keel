import 'package:eyeler_mobile/features/analytics/analytics_contract.dart';

const walletAddress = '0x0000000000000000000000000000000000000001';

V1Position walletPosition(
        String id, String side, String size, String? mark, String? notional,
        {int marketId = 1, String symbol = 'BTC'}) =>
    V1Position(id, marketId, symbol, side, size, notional, '1', mark, '1', '1',
        null, null, DateTime.utc(2026, 10, 1));

V1Envelope<V1WalletProfile> walletSnapshot(
        int block, List<V1Position> positions,
        {List<String> accounts = const ['1'],
        String? equity = '100',
        bool stale = false,
        DateTime? asOf,
        String source = 'monad_exchange'}) =>
    V1Envelope(
      asOf ?? DateTime.utc(2026, 10, 13, 12, 0, block),
      block,
      source,
      stale,
      V1WalletProfile(walletAddress, accounts,
          V1Margin(null, null, null, equity), positions),
    );
