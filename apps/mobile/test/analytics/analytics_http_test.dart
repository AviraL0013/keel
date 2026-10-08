import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/features/analytics/analytics_repository.dart';
import 'package:flutter_test/flutter_test.dart';

const address = '0x1234567890abcdef1234567890abcdef12345678';

Map<String, dynamic> fixture(String name) =>
    jsonDecode(File('test/fixtures/analytics/_$name.json').readAsStringSync())
        as Map<String, dynamic>;

void main() {
  final paths = <String>[];
  Future<Object?> get(String path) async {
    paths.add(path);
    final uri = Uri.parse(path);
    if (uri.path.endsWith('/protocol/summary')) {
      final raw = fixture('protocol_summary');
      (raw['data'] as Map<String, dynamic>)['window'] =
          uri.queryParameters['window'];
      return raw;
    }
    if (uri.path.endsWith('/protocol/timeseries')) {
      return fixture('protocol_timeseries');
    }
    if (uri.path.endsWith('/protocol/flows')) {
      final raw = fixture('protocol_flows');
      (raw['data'] as Map<String, dynamic>)['window'] =
          uri.queryParameters['window'];
      return raw;
    }
    if (uri.path.endsWith('/markets')) return fixture('markets');
    if (uri.path.endsWith('/markets/1')) return fixture('markets_id');
    if (uri.path.endsWith('/markets/1/funding')) {
      return fixture('markets_id_funding');
    }
    if (uri.path.endsWith('/markets/1/prices')) {
      final raw = fixture('markets_id_prices');
      final data = raw['data'] as Map<String, dynamic>;
      data['from'] = uri.queryParameters['from'];
      data['to'] = uri.queryParameters['to'];
      data['interval'] = uri.queryParameters['interval'];
      final from = DateTime.parse(data['from'] as String);
      final to = DateTime.parse(data['to'] as String);
      data['points'] = (data['points'] as List<dynamic>).where((point) {
        final time = DateTime.parse(point['time'] as String);
        return !time.isBefore(from) && time.isBefore(to);
      }).toList();
      return raw;
    }
    if (uri.path.endsWith('/liquidations')) return fixture('liquidations');
    if (uri.path.endsWith('/search')) return fixture('search');
    if (uri.path.endsWith('/wallets/$address')) {
      return fixture('wallets_address');
    }
    if (uri.path.endsWith('/wallets/$address/performance')) {
      return fixture('wallets_address_performance');
    }
    if (uri.path.endsWith('/wallets/$address/trades')) {
      return fixture('wallets_address_trades');
    }
    throw StateError('Unexpected path: $path');
  }

  test('composes v1 overview with exact paths and funding units', () async {
    paths.clear();
    final repository = HttpAnalyticsRepository(get);
    final overview = await repository.overview();
    expect(overview.windows.keys, containsAll(['24h', '7d', '30d', 'All']));
    expect(overview.windows['24h']!.first.value, '1200000.000000');
    expect(overview.markets.first.funding, '0.0012');
    expect(overview.liquidations.first.address, address);
    expect(overview.liquidationCount, 1);
    expect(paths.where((path) => path.contains('/protocol/summary?')),
        hasLength(4));
    expect(paths.every((path) => path.startsWith('/analytics/v1/')), isTrue);
    paths.clear();
    await repository.overview();
    expect(paths.where((path) => path.contains('/protocol/summary?')),
        hasLength(1));
  });

  test('composes market, wallet, search and trade endpoints', () async {
    paths.clear();
    final repository = HttpAnalyticsRepository(get,
        now: () => DateTime.parse('2026-10-07T16:00:00.000Z'));
    final market = await repository.market('BTC', '24h');
    expect(market.fundingHistory.first.value, '0.0012');
    expect(market.priceSeries.map((p) => p.value), ['85607.9', '85702.0']);
    expect(market.stale, isTrue);
    expect(paths.any((path) => path.contains('/markets/1/prices?interval=1h&')),
        isTrue);
    expect(paths.any((path) => path.contains('/markets/1/funding?')), isTrue);
    final wallet = await repository.wallet(address);
    expect(wallet.margin.available, '8000.000000');
    expect(wallet.positions.first.liquidationDistance, '27.1');
    expect(wallet.performance.averageHoldHours, '1.5');
    expect(wallet.performance.bestMarket, 'BTC');
    final trades = await repository.trades(address);
    expect(trades.rows.first.realizedPnl, '125.000000');
    expect(await repository.search('0x123456'), [address]);
  });

  test('keeps unavailable wallet values null', () async {
    final repository = HttpAnalyticsRepository((path) async {
      final raw = await get(path);
      if (Uri.parse(path).path.endsWith('/wallets/$address')) {
        final data =
            (raw as Map<String, dynamic>)['data'] as Map<String, dynamic>;
        (data['margin'] as Map<String, dynamic>)['equity'] = null;
        final position =
            (data['positions'] as List<dynamic>).first as Map<String, dynamic>;
        position['unrealizedPnl'] = null;
        position['liquidationPrice'] = null;
      }
      return raw;
    });
    final wallet = await repository.wallet(address);
    expect(wallet.margin.equity, isNull);
    expect(wallet.positions.first.unrealizedPnl, isNull);
    expect(wallet.positions.first.liquidationDistance, isNull);
  });

  test('refuses foreign price identity and leaves missing prices null',
      () async {
    for (final field in ['marketId', 'interval', 'from']) {
      final repository = HttpAnalyticsRepository((path) async {
        final raw = await get(path);
        if (Uri.parse(path).path.endsWith('/prices')) {
          final data =
              (raw as Map<String, dynamic>)['data'] as Map<String, dynamic>;
          data[field] = switch (field) {
            'marketId' => 2,
            'interval' => '1d',
            _ => '2026-01-01T00:00:00.000Z'
          };
        }
        return raw;
      });
      await expectLater(repository.market('BTC', '24h'), throwsFormatException);
    }
    final repository = HttpAnalyticsRepository((path) async {
      final raw = await get(path);
      if (Uri.parse(path).path.endsWith('/prices')) {
        (raw as Map<String, dynamic>)['data']['points'][0]['value'] = null;
      }
      return raw;
    }, now: () => DateTime.parse('2026-10-07T16:00:00.000Z'));
    expect((await repository.market('BTC', '24h')).priceSeries.first.value,
        isNull);
  });

  test('keeps signed liquidation distance for a short past threshold',
      () async {
    final repository = HttpAnalyticsRepository((path) async {
      final raw = await get(path);
      if (Uri.parse(path).path.endsWith('/wallets/$address')) {
        final data =
            (raw as Map<String, dynamic>)['data'] as Map<String, dynamic>;
        final position =
            (data['positions'] as List<dynamic>).first as Map<String, dynamic>;
        position['side'] = 'short';
      }
      return raw;
    });
    expect(
        (await repository.wallet(address)).positions.first.liquidationDistance,
        '-27.1');
  });
}
