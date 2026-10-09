import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../core/config/environment.dart';
import 'analytics_contract.dart';
import 'analytics_fixture.dart';
import 'analytics_models.dart';
import 'public_analytics_client.dart';

abstract interface class AnalyticsRepository {
  Future<AnalyticsOverview> overview();
  Future<AnalyticsMarketDetail> market(String symbol, String window);
  Future<AnalyticsWallet> wallet(String address);
  Future<AnalyticsTradePage> trades(String address, {String? cursor});
  Future<List<String>> search(String query);
}

/// Composes public v1 endpoints into screen view models.
class HttpAnalyticsRepository implements AnalyticsRepository {
  HttpAnalyticsRepository(this._get, {DateTime Function()? now})
      : _now = now ?? DateTime.now;
  final Future<Object?> Function(String path) _get;
  final DateTime Function() _now;
  // Server query boundaries use canonical UTC ISO strings at millisecond precision.
  static String _wireTime(DateTime value) =>
      DateTime.fromMillisecondsSinceEpoch(value.millisecondsSinceEpoch,
              isUtc: true)
          .toIso8601String();
  static const _base = '/analytics/v1';
  final Map<String, _WindowResponse> _historical = {};
  Map<int, String>? _symbols;
  V1Envelope<List<V1Market>>? _marketSnapshot;
  DateTime? _marketFetched;

  Future<V1Envelope<T>> _request<T>(
          String path, T Function(Object?) parse) async =>
      V1Envelope.fromJson(await _get('$_base$path'), parse);

  Future<V1Envelope<List<V1Market>>> _markets() async {
    if (_marketSnapshot case final cached?) {
      if (_marketFetched != null &&
          _now().toUtc().difference(_marketFetched!) <
              const Duration(seconds: 15)) {
        return cached;
      }
    }
    final response = await _request(
        '/markets',
        (raw) =>
            V1.list(AnalyticsParse.object(raw), 'items', V1Market.fromJson));
    _symbols = {for (final market in response.data) market.id: market.symbol};
    _marketSnapshot = response;
    _marketFetched = _now().toUtc();
    return response;
  }

  Future<String> _symbol(int id) async {
    if (_symbols == null) await _markets();
    return _symbols?[id] ?? 'Market $id';
  }

  Future<_WindowResponse> _window(String window, DateTime now) async {
    final cached = _historical[window];
    if (window != '24h' && cached != null) {
      if (now.difference(cached.fetchedAt) < const Duration(minutes: 5)) {
        return cached;
      }
    }
    final days = switch (window) {
      '24h' => 1,
      '7d' => 7,
      '30d' => 30,
      _ => 730,
    };
    final interval = days >= 30 ? '1d' : '1h';
    final from = _wireTime(now.subtract(Duration(days: days)));
    final to = _wireTime(now);
    final results = await Future.wait<Object>([
      _request('/protocol/summary?window=$window', V1ProtocolSummary.fromJson),
      _request(
          '/protocol/timeseries?metric=volume&interval=$interval&from=${Uri.encodeQueryComponent(from)}&to=${Uri.encodeQueryComponent(to)}',
          V1Timeseries.fromJson),
      _request('/protocol/flows?window=$window', V1Flows.fromJson),
    ]);
    final response = _WindowResponse(
      results[0] as V1Envelope<V1ProtocolSummary>,
      results[1] as V1Envelope<V1Timeseries>,
      results[2] as V1Envelope<V1Flows>,
      now,
    );
    if (response.summary.data.window != window ||
        response.flows.data.window != window ||
        response.timeseries.data.metric != 'volume') {
      throw const FormatException('Mismatched analytics window');
    }
    if (window != '24h') _historical[window] = response;
    return response;
  }

  @override
  Future<AnalyticsOverview> overview() async {
    final now = _now().toUtc();
    final responses = await Future.wait([
      _window('24h', now),
      _window('7d', now),
      _window('30d', now),
      _window('all', now),
    ]);
    final markets = await _markets();
    final liquidations =
        await _request('/liquidations?limit=50', V1LiquidationPage.fromJson);
    final windows = <String, List<AnalyticsMetric>>{};
    final volumeSeries = <String, List<AnalyticsPoint>>{};
    final inflowSeries = <String, List<AnalyticsPoint>>{};
    final historyLabels = <String, String>{};
    for (var i = 0; i < responses.length; i++) {
      final key = ['24h', '7d', '30d', 'All'][i];
      final item = responses[i];
      if (item.summary.coverage case final coverage?) {
        historyLabels[key] = coverage.completeHistory
            ? 'All time'
            : '${coverage.label} · history incomplete';
      }
      final metrics = item.summary.data.metrics;
      windows[key] = [
        for (final (label, field) in [
          ('volume', 'volume'),
          ('oi', 'openInterest'),
          ('tvl', 'tvl'),
          ('fees', 'fees'),
          ('activeUsers', 'activeUsers'),
        ])
          AnalyticsMetric(
              label, metrics[field]!.value, metrics[field]!.changePct),
      ];
      volumeSeries[key] =
          item.timeseries.data.points.map((point) => point.toView()).toList();
      inflowSeries[key] = item.flows.data.buckets
          .map((bucket) => AnalyticsPoint(bucket.time, bucket.net))
          .toList();
    }
    final symbols = _symbols ?? {};
    return AnalyticsOverview(
      responses.first.summary.asOf,
      windows,
      volumeSeries['24h']!,
      inflowSeries['24h']!,
      [
        for (final item in markets.data)
          AnalyticsMarket(item.symbol, item.volume24h, item.openInterest,
              item.longSharePct, _fundingPercent(item.fundingRate))
      ],
      liquidations.data.notional,
      [
        for (final item in liquidations.data.items)
          AnalyticsLiquidation(
              item.id,
              item.time,
              symbols[item.marketId] ?? 'Market ${item.marketId}',
              item.address,
              item.side,
              item.notional)
      ],
      null,
      volumeSeriesByWindow: volumeSeries,
      inflowSeriesByWindow: inflowSeries,
      liquidationCount: liquidations.data.count,
      historyLabels: historyLabels,
      stale: responses.any((item) =>
              item.summary.stale ||
              item.timeseries.stale ||
              item.flows.stale) ||
          markets.stale ||
          liquidations.stale,
    );
  }

  @override
  Future<AnalyticsMarketDetail> market(String symbol, String window) async {
    final markets = await _markets();
    final matches = markets.data.where((market) => market.symbol == symbol);
    if (matches.isEmpty) throw StateError('No market analytics');
    final id = matches.first.id;
    final now = _now().toUtc();
    final from = _wireTime(now.subtract(Duration(
        days: window == 'All'
            ? 30
            : window == '30d'
                ? 30
                : window == '7d'
                    ? 7
                    : 1)));
    final to = _wireTime(now);
    final detail = await _request('/markets/$id', V1MarketDetail.fromJson);
    final funding = await _request(
        '/markets/$id/funding?from=${Uri.encodeQueryComponent(from)}&to=${Uri.encodeQueryComponent(to)}',
        V1MarketFunding.fromJson);
    final prices = await _request(
        '/markets/$id/prices?interval=1h&from=${Uri.encodeQueryComponent(from)}&to=${Uri.encodeQueryComponent(to)}',
        V1MarketPrices.fromJson);
    if (detail.data.market.id != id ||
        funding.data.marketId != id ||
        prices.data.marketId != id ||
        prices.data.interval != '1h' ||
        _wireTime(prices.data.from) != from ||
        _wireTime(prices.data.to) != to) {
      throw const FormatException('Mismatched market ID');
    }
    final liquidations = await _request(
        '/liquidations?marketId=$id&from=${Uri.encodeQueryComponent(from)}&to=${Uri.encodeQueryComponent(to)}&limit=50',
        V1LiquidationPage.fromJson);
    return AnalyticsMarketDetail(
        symbol,
        prices.asOf.isBefore(detail.asOf) ? prices.asOf : detail.asOf,
        prices.data.points.map((point) => point.toView()).toList(),
        detail.data.market.longSharePct,
        [
          for (final point in funding.data.points)
            AnalyticsPoint(point.time, _fundingPercent(point.rate))
        ],
        [
          for (final item in liquidations.data.items)
            AnalyticsLiquidation(item.id, item.time, symbol, item.address,
                item.side, item.notional)
        ],
        stale: detail.stale ||
            funding.stale ||
            prices.stale ||
            liquidations.stale);
  }

  @override
  Future<AnalyticsWallet> wallet(String address) async {
    if (!isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    final encoded = Uri.encodeComponent(address);
    final profile =
        await _request('/wallets/$encoded', V1WalletProfile.fromJson);
    final performance = await _request(
        '/wallets/$encoded/performance', V1WalletPerformance.fromJson);
    if (profile.data.address.toLowerCase() != address.toLowerCase() ||
        performance.data.address.toLowerCase() != address.toLowerCase()) {
      throw const FormatException('Mismatched wallet address');
    }
    await _markets();
    final p = performance.data;
    return AnalyticsWallet(
        address,
        profile.asOf,
        AnalyticsMargin(
            profile.data.margin.equity, profile.data.margin.free, null,
            balance: profile.data.margin.balance,
            locked: profile.data.margin.locked),
        [
          for (final item in profile.data.positions)
            AnalyticsPosition(
                item.symbol,
                item.side,
                item.size,
                item.entryPrice,
                item.leverage,
                item.unrealizedPnl,
                item.liquidationPrice,
                _liquidationDistance(
                    item.side, item.markPrice, item.liquidationPrice))
        ],
        AnalyticsPerformance(
            p.winRatePct,
            p.profitFactor,
            p.maxDrawdownPct,
            p.currentStreak.toString(),
            _hours(p.averageHoldSeconds),
            p.bestMarketId == null ? null : await _symbol(p.bestMarketId!),
            p.worstMarketId == null ? null : await _symbol(p.worstMarketId!),
            p.equityCurve.map((point) => point.toView()).toList()),
        stale: profile.stale || performance.stale);
  }

  @override
  Future<AnalyticsTradePage> trades(String address, {String? cursor}) async {
    if (!isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    final path = '/wallets/${Uri.encodeComponent(address)}/trades?limit=50'
        '${cursor == null ? '' : '&cursor=${Uri.encodeQueryComponent(cursor)}'}';
    final page = await _request(path, V1TradePage.fromJson);
    await _markets();
    return AnalyticsTradePage([
      for (final item in page.data.items)
        AnalyticsTrade(item.id, item.time, await _symbol(item.marketId),
            item.side, item.size, item.realizedPnl),
    ], page.data.nextCursor);
  }

  @override
  Future<List<String>> search(String query) async {
    final result = await _request(
        '/search?q=${Uri.encodeQueryComponent(query)}', V1Search.fromJson);
    return result.data.items.map((item) => item.address).toList();
  }
}

class _WindowResponse {
  const _WindowResponse(
      this.summary, this.timeseries, this.flows, this.fetchedAt);
  final V1Envelope<V1ProtocolSummary> summary;
  final V1Envelope<V1Timeseries> timeseries;
  final V1Envelope<V1Flows> flows;
  final DateTime fetchedAt;
}

String? _fundingPercent(String? fraction) {
  if (fraction == null) return null;
  final negative = fraction.startsWith('-');
  final parts = (negative ? fraction.substring(1) : fraction).split('.');
  final integer = BigInt.parse(parts.first);
  final digits = parts.length == 2 ? parts.last : '';
  final scaled = integer * BigInt.from(10).pow(digits.length) +
      BigInt.parse(digits.isEmpty ? '0' : digits);
  final shifted = scaled * BigInt.from(100);
  final scale = BigInt.from(10).pow(digits.length);
  final whole = shifted ~/ scale;
  final remainder = shifted % scale;
  final decimal = remainder == BigInt.zero
      ? ''
      : '.${remainder.toString().padLeft(digits.length, '0').replaceFirst(RegExp(r'0+$'), '')}';
  return '${negative ? '-' : ''}$whole$decimal';
}

String? _hours(int? seconds) {
  if (seconds == null) return null;
  final tenths = BigInt.from(seconds) * BigInt.from(10) ~/ BigInt.from(3600);
  return '${tenths ~/ BigInt.from(10)}.${tenths % BigInt.from(10)}';
}

String? _liquidationDistance(String side, String? mark, String? liquidation) {
  if (mark == null || liquidation == null) return null;
  final markDecimals = mark.contains('.') ? mark.split('.').last.length : 0;
  final liqDecimals =
      liquidation.contains('.') ? liquidation.split('.').last.length : 0;
  final places = markDecimals > liqDecimals ? markDecimals : liqDecimals;
  BigInt scaled(String input) {
    final parts = input.split('.');
    return BigInt.parse(parts.first) * BigInt.from(10).pow(places) +
        BigInt.parse(
            parts.length == 2 ? parts.last.padRight(places, '0') : '0');
  }

  final markValue = scaled(mark);
  if (markValue <= BigInt.zero) return null;
  final liquidationValue = scaled(liquidation);
  final signed = side == 'short'
      ? liquidationValue - markValue
      : markValue - liquidationValue;
  final tenths = signed.abs() * BigInt.from(1000) ~/ markValue;
  return '${signed.isNegative ? '-' : ''}${tenths ~/ BigInt.from(10)}.${tenths % BigInt.from(10)}';
}

class FixtureAnalyticsRepository implements AnalyticsRepository {
  FixtureAnalyticsRepository.fromJson(String source)
      : data = AnalyticsParse.object(jsonDecode(source));
  FixtureAnalyticsRepository.sample()
      : data = AnalyticsParse.object(jsonDecode(analyticsSampleJson));

  final Map<String, dynamic> data;

  @override
  Future<AnalyticsOverview> overview() async =>
      AnalyticsOverview.fromJson(data['overview']);

  @override
  Future<AnalyticsMarketDetail> market(String symbol, String window) async {
    final details = AnalyticsParse.object(data['marketDetails']);
    if (!details.containsKey(symbol)) throw StateError('No market analytics');
    return AnalyticsMarketDetail.fromJson(details[symbol]);
  }

  @override
  Future<AnalyticsWallet> wallet(String address) async {
    if (!isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    final wallets = AnalyticsParse.object(data['wallets']);
    final match = wallets.entries.where(
      (entry) => entry.key.toLowerCase() == address.toLowerCase(),
    );
    if (match.isEmpty) throw StateError('No wallet analytics');
    return AnalyticsWallet.fromJson(match.first.value);
  }

  @override
  Future<AnalyticsTradePage> trades(String address, {String? cursor}) async {
    if (!isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    final pages = AnalyticsParse.object(data['trades']);
    final match = pages.entries.where(
      (entry) => entry.key.toLowerCase() == address.toLowerCase(),
    );
    if (match.isEmpty || cursor != null) {
      return const AnalyticsTradePage([], null);
    }
    return AnalyticsTradePage.fromJson(match.first.value);
  }

  @override
  Future<List<String>> search(String query) async {
    final normalized = query.toLowerCase();
    if (!RegExp(r'^0x[0-9a-f]{6,40}$').hasMatch(normalized)) {
      throw const FormatException('Invalid address prefix');
    }
    return AnalyticsParse.object(data['wallets'])
        .keys
        .where((address) => address.toLowerCase().startsWith(normalized))
        .toList();
  }
}

const analyticsFixtureMode = bool.fromEnvironment(
  'EYELER_ANALYTICS_FIXTURE',
  defaultValue: false,
);

final analyticsRepositoryProvider = Provider<AnalyticsRepository>((ref) {
  if (analyticsFixtureMode) return FixtureAnalyticsRepository.sample();
  final client = http.Client();
  ref.onDispose(client.close);
  final api =
      PublicAnalyticsClient(ref.watch(configProvider).apiBaseUrl, client);
  return HttpAnalyticsRepository(api.get);
});
