import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/features/analytics/analytics_models.dart';
import 'package:eyeler_mobile/features/analytics/analytics_repository.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final source = File('test/fixtures/analytics/sample.json').readAsStringSync();
  final fixture = jsonDecode(source) as Map<String, dynamic>;

  test('parses every local fixture response', () async {
    final repository = FixtureAnalyticsRepository.fromJson(source);
    final overview = await repository.overview();
    expect(overview.windows.keys, containsAll(['24h', '7d', '30d', 'All']));
    expect(overview.markets.first.symbol, 'BTC-PERP');
    expect(overview.liquidations.first.address,
        '0x0000000000000000000000000000000000000001');
    final market = await repository.market('BTC-PERP', '24h');
    expect(market.fundingHistory, hasLength(2));
    final wallet =
        await repository.wallet(overview.liquidations.first.address!);
    expect(wallet.positions.first.liquidationDistance, '16.3');
    final trades = await repository.trades(wallet.address);
    expect(trades.rows.first.realizedPnl, '124.52');
  });

  test('keeps decimal precision past double integer range', () {
    expect(AnalyticsNumbers.compact('9007199254740993', places: 1),
        r'$9007199.3B');
    expect(AnalyticsNumbers.compact('0.004', places: 3), r'$0.004');
    expect(AnalyticsNumbers.compact('-1234.56'), r'-$1.2K');
  });

  test('rejects number values and invalid decimal strings', () {
    final copy = jsonDecode(jsonEncode(fixture)) as Map<String, dynamic>;
    final overview = copy['overview'] as Map<String, dynamic>;
    final windows = overview['windows'] as Map<String, dynamic>;
    final day = windows['24h'] as List<dynamic>;
    (day.first as Map<String, dynamic>)['value'] = 12.34;
    expect(() => AnalyticsOverview.fromJson(overview), throwsFormatException);
    (day.first as Map<String, dynamic>)['value'] = '1e9';
    expect(() => AnalyticsOverview.fromJson(overview), throwsFormatException);
  });

  test('validates addresses and timestamps', () {
    expect(isAnalyticsAddress('0x${'a' * 40}'), isTrue);
    expect(isAnalyticsAddress('0x${'A' * 40}'), isFalse);
    expect(isAnalyticsAddress('0x123'), isFalse);
    final copy = jsonDecode(jsonEncode(fixture)) as Map<String, dynamic>;
    final overview = copy['overview'] as Map<String, dynamic>;
    overview['asOf'] = 'yesterday';
    expect(() => AnalyticsOverview.fromJson(overview), throwsFormatException);
  });
}
