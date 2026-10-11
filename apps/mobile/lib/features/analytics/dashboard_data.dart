import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../core/config/environment.dart';
import 'analytics_contract.dart';
import 'analytics_models.dart';
import 'public_analytics_client.dart';

enum DashboardRange {
  week('7D', 7),
  month('30D', 30),
  quarter('90D', 90),
  all('All', 730);

  const DashboardRange(this.label, this.days);
  final String label;
  final int days;
}

/// Exact arithmetic for aggregation and CSV. Doubles are used only by painters.
class AnalyticsDecimal implements Comparable<AnalyticsDecimal> {
  const AnalyticsDecimal(this.units, this.scale);
  final BigInt units;
  final int scale;
  factory AnalyticsDecimal.parse(String input) {
    AnalyticsParse.decimal({'value': input}, 'value');
    final parts = input.split('.');
    return AnalyticsDecimal(
        BigInt.parse(parts.join()), parts.length == 2 ? parts.last.length : 0);
  }
  AnalyticsDecimal operator +(AnalyticsDecimal other) {
    final places = scale > other.scale ? scale : other.scale;
    return AnalyticsDecimal(
        units * BigInt.from(10).pow(places - scale) +
            other.units * BigInt.from(10).pow(places - other.scale),
        places);
  }

  AnalyticsDecimal get negative => AnalyticsDecimal(-units, scale);
  @override
  int compareTo(AnalyticsDecimal other) => (this + other.negative).units.sign;
  @override
  String toString() {
    final digits = units.abs().toString().padLeft(scale + 1, '0');
    return '${units.isNegative ? '-' : ''}${scale == 0 ? digits : '${digits.substring(0, digits.length - scale)}.${digits.substring(digits.length - scale)}'}';
  }

  static String? sum(Iterable<String?> values) {
    if (values.isEmpty || values.any((v) => v == null)) return null;
    return values
        .map((v) => AnalyticsDecimal.parse(v!))
        .reduce((a, b) => a + b)
        .toString();
  }
}

String analyticsSource(String source) => switch (source) {
      'perpl_api' => 'Perpl API',
      'monad_exchange' => 'Monad events',
      'derived' => 'Derived from source data',
      'external' => 'External source',
      _ => 'Source unavailable',
    };

String utcDate(DateTime date) =>
    date.toUtc().toIso8601String().substring(0, 10);
String utcExact(DateTime date) => '${date.toUtc().toIso8601String()} UTC';
String wireTime(DateTime date) =>
    DateTime.fromMillisecondsSinceEpoch(date.millisecondsSinceEpoch,
            isUtc: true)
        .toIso8601String();

/// Sums only buckets returned by the API, with no generated hours or days.
List<V1FlowBucket> dailyAnalyticsFlows(List<V1FlowBucket> buckets) {
  final days = <DateTime, List<V1FlowBucket>>{};
  for (final bucket in buckets) {
    final at = bucket.time.toUtc();
    days
        .putIfAbsent(DateTime.utc(at.year, at.month, at.day), () => [])
        .add(bucket);
  }
  final result = [
    for (final day in days.entries)
      V1FlowBucket(
          day.key,
          AnalyticsDecimal.sum(day.value.map((b) => b.deposits))!,
          AnalyticsDecimal.sum(day.value.map((b) => b.withdrawals))!,
          AnalyticsDecimal.sum(day.value.map((b) => b.net))!)
  ];
  return result..sort((a, b) => a.time.compareTo(b.time));
}

class DashboardSeries {
  const DashboardSeries(this.label, this.points, {this.marketId});
  final String label;
  final int? marketId;
  final List<AnalyticsPoint> points;
}

/// The optional marketSeries addition is ignored unless it matches every total.
/// Existing v1 responses continue to display their authoritative protocol series.
class DashboardHistory {
  const DashboardHistory(this.total, this.markets,
      {this.historyStartedAt, this.unavailableReason});
  final V1Timeseries total;
  final List<DashboardSeries> markets;
  final DateTime? historyStartedAt;
  final String? unavailableReason;
  factory DashboardHistory.fromJson(Object? raw) {
    final json = AnalyticsParse.object(raw);
    final total = V1Timeseries.fromJson(raw);
    final markets = <DashboardSeries>[];
    if (json['marketSeries'] is List) {
      try {
        final ids = <int>{};
        for (final entry in json['marketSeries'] as List) {
          final item = AnalyticsParse.object(entry);
          final id = V1.integer(item, 'marketId');
          if (!ids.add(id)) throw const FormatException('Duplicate market');
          final points = V1.list(item, 'points', V1TimePoint.fromJson);
          if (points.length != total.points.length) {
            throw const FormatException('Incomplete market series');
          }
          for (var i = 0; i < points.length; i++) {
            if (points[i].time != total.points[i].time) {
              throw const FormatException('Mismatched market bucket');
            }
          }
          markets.add(DashboardSeries(AnalyticsParse.string(item, 'symbol'),
              points.map((p) => p.toView()).toList(),
              marketId: id));
        }
        for (var i = 0; i < total.points.length; i++) {
          final sum =
              AnalyticsDecimal.sum(markets.map((m) => m.points[i].value));
          final value = total.points[i].value;
          if ((sum == null) != (value == null) ||
              (sum != null &&
                  AnalyticsDecimal.parse(sum)
                          .compareTo(AnalyticsDecimal.parse(value!)) !=
                      0)) {
            throw const FormatException('Unreconciled market series');
          }
        }
      } on FormatException {
        markets.clear();
      }
    }
    return DashboardHistory(total, markets,
        historyStartedAt: json['historyStartedAt'] == null
            ? null
            : AnalyticsParse.time(json, 'historyStartedAt'),
        unavailableReason:
            AnalyticsParse.optionalString(json, 'unavailableReason'));
  }
}

class _CachedResponse {
  const _CachedResponse(this.value, this.expires);
  final Object? value;
  final DateTime expires;
}

class DashboardSummary extends V1ProtocolSummary {
  DashboardSummary(V1ProtocolSummary summary, this.revenueHistory)
      : super(summary.window, summary.metrics);
  final V1Envelope<V1Timeseries>? revenueHistory;
  factory DashboardSummary.fromJson(Object? raw) {
    final json = AnalyticsParse.object(raw);
    final revenue = AnalyticsParse.object(json['revenue']);
    V1Envelope<V1Timeseries>? history;
    if (revenue['history'] != null) {
      try {
        history = V1Envelope.fromJson(revenue['history'], (data) {
          final j = AnalyticsParse.object(data);
          final from = AnalyticsParse.time(j, 'from');
          final to = AnalyticsParse.time(j, 'to');
          final points = V1.list(j, 'points', V1TimePoint.fromJson);
          if (j['interval'] != '1d' ||
              !from.isBefore(to) ||
              points.length > 730) {
            throw const FormatException('Invalid revenue history');
          }
          DateTime? previous;
          for (final point in points) {
            if (point.time.isBefore(from) ||
                !point.time.isBefore(to) ||
                point.time.millisecondsSinceEpoch % 86400000 != 0 ||
                (previous != null && !point.time.isAfter(previous))) {
              throw const FormatException('Invalid revenue bucket');
            }
            previous = point.time;
          }
          return V1Timeseries('revenue', '1d', from, to, points);
        });
      } on FormatException {
        // An unusable optional series must not conceal a valid summary.
        history = null;
      }
    }
    return DashboardSummary(V1ProtocolSummary.fromJson(raw), history);
  }
}

class DashboardLiquidationPage extends V1LiquidationPage {
  DashboardLiquidationPage(V1LiquidationPage page, this.dailyNotional)
      : super(page.items, page.nextCursor, page.count, page.notional);
  final V1Timeseries? dailyNotional;
  factory DashboardLiquidationPage.fromJson(Object? raw) {
    final json = AnalyticsParse.object(raw);
    V1Timeseries? daily;
    if (json['dailyNotional'] != null) {
      try {
        final j = AnalyticsParse.object(json['dailyNotional']);
        if (j['interval'] != '1d') {
          throw const FormatException('Invalid liquidation interval');
        }
        daily = V1Timeseries(
            'liquidations',
            '1d',
            AnalyticsParse.time(j, 'from'),
            AnalyticsParse.time(j, 'to'),
            V1.list(j, 'points', V1TimePoint.fromJson));
      } on FormatException {
        daily = null;
      }
    }
    return DashboardLiquidationPage(V1LiquidationPage.fromJson(raw), daily);
  }
}

/// Per-endpoint caching and in-flight coalescing. A failed history request never
/// holds up a snapshot, and failed responses are never cached as successful data.
class DashboardApi {
  DashboardApi(this.get, {DateTime Function()? now})
      : now = now ?? DateTime.now;
  final Future<Object?> Function(String) get;
  final DateTime Function() now;
  final _cache = <String, _CachedResponse>{};
  final _pending = <String, Future<Object?>>{};
  Future<V1Envelope<T>> request<T>(String path, T Function(Object?) parse,
      {Duration ttl = const Duration(seconds: 30),
      void Function(T)? validate}) async {
    final cached = _cache[path];
    Object? raw;
    if (cached != null && now().isBefore(cached.expires)) {
      raw = cached.value;
    } else {
      final pending = _pending.putIfAbsent(path, () async {
        try {
          final value = await get('/analytics/v1$path')
              .timeout(const Duration(seconds: 18));
          _cache[path] = _CachedResponse(value, now().add(ttl));
          // Bound sessions which visit many ranges and wallets.
          if (_cache.length > 120) _cache.remove(_cache.keys.first);
          return value;
        } finally {
          _pending.remove(path);
        }
      });
      raw = await pending;
    }
    try {
      final result = V1Envelope.fromJson(raw, parse);
      validate?.call(result.data);
      return result;
    } catch (_) {
      _cache.remove(path);
      rethrow;
    }
  }

  (DateTime, DateTime) bounds(DashboardRange range) {
    final current = now().toUtc();
    final to = DateTime.utc(current.year, current.month, current.day);
    return (to.subtract(Duration(days: range.days)), to);
  }

  String rangeQuery(DashboardRange range) {
    final (from, to) = bounds(range);
    return 'from=${Uri.encodeQueryComponent(wireTime(from))}&to=${Uri.encodeQueryComponent(wireTime(to))}';
  }

  Future<V1Envelope<DashboardSummary>> summary(String window) =>
      request('/protocol/summary?window=$window', DashboardSummary.fromJson,
          validate: (value) {
        if (value.window != window) {
          throw const FormatException('Mismatched summary window');
        }
      });

  Future<V1Envelope<DashboardHistory>> history(
      String metric, DashboardRange range) {
    final (from, to) = bounds(range);
    final query =
        'from=${Uri.encodeQueryComponent(wireTime(from))}&to=${Uri.encodeQueryComponent(wireTime(to))}';
    return request('/protocol/timeseries?metric=$metric&interval=1d&$query',
        DashboardHistory.fromJson, ttl: const Duration(minutes: 5),
        validate: (value) {
      final series = value.total;
      if (series.metric != metric ||
          series.interval != '1d' ||
          series.from != from ||
          series.to != to) {
        throw const FormatException('Mismatched history range');
      }
      DateTime? previous;
      for (final point in series.points) {
        if (point.time.isBefore(from) ||
            !point.time.isBefore(to) ||
            point.time.millisecondsSinceEpoch % 86400000 != 0 ||
            (previous != null && !point.time.isAfter(previous))) {
          throw const FormatException('Invalid history bucket');
        }
        previous = point.time;
      }
    });
  }

  Future<V1Envelope<V1Flows>> flows(String window) =>
      request('/protocol/flows?window=$window', V1Flows.fromJson,
          validate: (value) {
        if (value.window != window) {
          throw const FormatException('Mismatched flow window');
        }
      });

  Future<V1Envelope<List<V1Market>>> markets() => request('/markets',
      (raw) => V1.list(AnalyticsParse.object(raw), 'items', V1Market.fromJson));
  Future<V1Envelope<DashboardLiquidationPage>> liquidations(
      DashboardRange range,
      {String? cursor}) async {
    final result = await request(
        '/liquidations?${rangeQuery(range)}&limit=100${cursor == null ? '' : '&cursor=${Uri.encodeQueryComponent(cursor)}'}',
        DashboardLiquidationPage.fromJson);
    final daily = result.data.dailyNotional;
    final (from, to) = bounds(range);
    DateTime? previous;
    if (daily != null) {
      var valid = daily.from == from &&
          daily.to == to &&
          daily.points.length <= range.days;
      for (final point in daily.points) {
        valid = valid &&
            !point.time.isBefore(from) &&
            point.time.isBefore(to) &&
            point.time.millisecondsSinceEpoch % 86400000 == 0 &&
            (previous == null || point.time.isAfter(previous));
        previous = point.time;
      }
      if (!valid) {
        return V1Envelope(result.asOf, result.block, result.source,
            result.stale, DashboardLiquidationPage(result.data, null),
            coverage: result.coverage);
      }
    }
    return result;
  }
}

final dashboardNowProvider =
    Provider<DateTime Function()>((ref) => DateTime.now);

final dashboardApiProvider = Provider<DashboardApi>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return DashboardApi(
      PublicAnalyticsClient(ref.watch(configProvider).apiBaseUrl, client).get,
      now: ref.watch(dashboardNowProvider));
});
final dashboardSummaryProvider =
    FutureProvider.family<V1Envelope<DashboardSummary>, String>(
        (ref, window) => ref.watch(dashboardApiProvider).summary(window));
final dashboardHistoryProvider = FutureProvider.family<
    V1Envelope<DashboardHistory>,
    (
      String,
      DashboardRange
    )>((ref, key) => ref.watch(dashboardApiProvider).history(key.$1, key.$2));
final dashboardFlowsProvider =
    FutureProvider.family<V1Envelope<V1Flows>, String>(
        (ref, window) => ref.watch(dashboardApiProvider).flows(window));
final dashboardMarketsProvider = FutureProvider<V1Envelope<List<V1Market>>>(
    (ref) => ref.watch(dashboardApiProvider).markets());
final dashboardLiquidationsProvider =
    FutureProvider.family<V1Envelope<DashboardLiquidationPage>, DashboardRange>(
        (ref, range) => ref.watch(dashboardApiProvider).liquidations(range));
