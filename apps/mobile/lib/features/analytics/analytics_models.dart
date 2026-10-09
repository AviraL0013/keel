import 'package:web3dart/web3dart.dart';

/// View models assembled from analytics API v1 responses.
abstract final class AnalyticsParse {
  static Map<String, dynamic> object(Object? value) {
    if (value is! Map<String, dynamic>) {
      throw const FormatException('Expected object');
    }
    return value;
  }

  static List<dynamic> array(Object? value) {
    if (value is! List<dynamic>) throw const FormatException('Expected array');
    return value;
  }

  static String string(Map<String, dynamic> json, String key) {
    final value = json[key];
    if (value is! String || value.isEmpty) {
      throw FormatException('Invalid $key');
    }
    return value;
  }

  static String decimal(Map<String, dynamic> json, String key) {
    final value = string(json, key);
    if (!RegExp(r'^-?(?:0|[1-9]\d*)(?:\.\d+)?$').hasMatch(value)) {
      throw FormatException('Invalid decimal $key');
    }
    return value;
  }

  static String? optionalDecimal(Map<String, dynamic> json, String key) =>
      json[key] == null ? null : decimal(json, key);

  static String? optionalString(Map<String, dynamic> json, String key) =>
      json[key] == null ? null : string(json, key);

  static DateTime time(Map<String, dynamic> json, String key) {
    final raw = string(json, key);
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$')
        .hasMatch(raw)) {
      throw FormatException('Invalid UTC $key');
    }
    final value = DateTime.tryParse(raw);
    if (value == null ||
        !value.isUtc ||
        value.toIso8601String().substring(0, 19) != raw.substring(0, 19)) {
      throw FormatException('Invalid UTC $key');
    }
    return value;
  }
}

/// Exact base-ten display, including values beyond IEEE 754's integer range.
abstract final class AnalyticsNumbers {
  static String compact(String? input, {bool money = true, int places = 1}) {
    if (input == null) return 'Unavailable';
    if (!RegExp(r'^-?(?:0|[1-9]\d*)(?:\.\d+)?$').hasMatch(input)) {
      throw const FormatException('Invalid decimal');
    }
    final negative = input.startsWith('-');
    final raw = negative ? input.substring(1) : input;
    final parts = raw.split('.');
    final whole = BigInt.parse(parts.first);
    final scale = parts.length == 2 ? parts.last.length : 0;
    final scaled = whole * BigInt.from(10).pow(scale) +
        BigInt.parse(parts.length == 2 ? parts.last : '0');
    final divisor = whole >= BigInt.from(1000000000)
        ? 1000000000
        : whole >= BigInt.from(1000000)
            ? 1000000
            : whole >= BigInt.from(1000)
                ? 1000
                : 1;
    final suffix = {1000000000: 'B', 1000000: 'M', 1000: 'K', 1: ''}[divisor]!;
    final outputScale = BigInt.from(10).pow(places);
    final denominator = BigInt.from(divisor) * BigInt.from(10).pow(scale);
    final rounded =
        (scaled * outputScale + denominator ~/ BigInt.two) ~/ denominator;
    final integer = rounded ~/ outputScale;
    final fraction = (rounded % outputScale).toString().padLeft(places, '0');
    final number = places == 0 || fraction.replaceAll('0', '').isEmpty
        ? '$integer'
        : '$integer.${fraction.replaceFirst(RegExp(r'0+$'), '')}';
    return '${negative ? '-' : ''}${money ? r'$' : ''}$number$suffix';
  }
}

class AnalyticsMetric {
  const AnalyticsMetric(this.key, this.value, this.delta);
  final String key;
  final String? value;
  final String? delta;
  factory AnalyticsMetric.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsMetric(
      AnalyticsParse.string(j, 'key'),
      AnalyticsParse.optionalDecimal(j, 'value'),
      AnalyticsParse.optionalDecimal(j, 'delta'),
    );
  }
}

class AnalyticsPoint {
  const AnalyticsPoint(this.at, this.value);
  final DateTime at;
  final String? value;
  factory AnalyticsPoint.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsPoint(
      AnalyticsParse.time(j, 'at'),
      AnalyticsParse.optionalDecimal(j, 'value'),
    );
  }
}

class AnalyticsMarket {
  const AnalyticsMarket(
    this.symbol,
    this.volume,
    this.oi,
    this.longShare,
    this.funding,
  );
  final String symbol;
  final String? volume, oi, longShare, funding;
  factory AnalyticsMarket.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsMarket(
      AnalyticsParse.string(j, 'symbol'),
      AnalyticsParse.optionalDecimal(j, 'volume'),
      AnalyticsParse.optionalDecimal(j, 'oi'),
      AnalyticsParse.optionalDecimal(j, 'longShare'),
      AnalyticsParse.optionalDecimal(j, 'funding'),
    );
  }
}

class AnalyticsLiquidation {
  const AnalyticsLiquidation(
    this.id,
    this.at,
    this.market,
    this.address,
    this.side,
    this.notional,
  );
  final String id, market;
  final String? address, side, notional;
  final DateTime at;
  factory AnalyticsLiquidation.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    final address = AnalyticsParse.optionalString(j, 'address');
    if (address != null && !isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    return AnalyticsLiquidation(
      AnalyticsParse.string(j, 'id'),
      AnalyticsParse.time(j, 'at'),
      AnalyticsParse.string(j, 'market'),
      address,
      AnalyticsParse.optionalString(j, 'side'),
      AnalyticsParse.optionalDecimal(j, 'notional'),
    );
  }
}

bool isAnalyticsAddress(String value) {
  if (!RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(value)) return false;
  final body = value.substring(2);
  if (body == body.toUpperCase() && body != body.toLowerCase()) return false;
  try {
    EthereumAddress.fromHex(value);
    return true;
  } catch (_) {
    return false;
  }
}

class AnalyticsOverview {
  const AnalyticsOverview(
      this.asOf,
      this.windows,
      this.volumeSeries,
      this.inflowSeries,
      this.markets,
      this.liquidationTotal,
      this.liquidations,
      this.insight,
      {this.volumeSeriesByWindow = const {},
      this.inflowSeriesByWindow = const {},
      this.historyLabels = const {},
      this.liquidationCount,
      this.stale = false});
  final DateTime asOf;
  final Map<String, List<AnalyticsMetric>> windows;
  final List<AnalyticsPoint> volumeSeries, inflowSeries;
  final Map<String, List<AnalyticsPoint>> volumeSeriesByWindow,
      inflowSeriesByWindow;
  final List<AnalyticsMarket> markets;
  final String? liquidationTotal;
  final int? liquidationCount;
  final List<AnalyticsLiquidation> liquidations;
  final String? insight;
  final bool stale;
  final Map<String, String> historyLabels;
  factory AnalyticsOverview.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    final windows = AnalyticsParse.object(j['windows']).map(
      (key, value) => MapEntry(
        key,
        AnalyticsParse.array(value).map(AnalyticsMetric.fromJson).toList(),
      ),
    );
    for (final key in ['24h', '7d', '30d', 'All']) {
      if (!windows.containsKey(key)) {
        throw FormatException('Missing $key window');
      }
    }
    final insight = j['insight'];
    if (insight != null && insight is! String) {
      throw const FormatException('Invalid insight');
    }
    final count = j['liquidationCount'];
    if (count != null && count is! int) {
      throw const FormatException('Invalid liquidationCount');
    }
    return AnalyticsOverview(
      AnalyticsParse.time(j, 'asOf'),
      windows,
      AnalyticsParse.array(j['volumeSeries'])
          .map(AnalyticsPoint.fromJson)
          .toList(),
      AnalyticsParse.array(j['inflowSeries'])
          .map(AnalyticsPoint.fromJson)
          .toList(),
      AnalyticsParse.array(j['markets']).map(AnalyticsMarket.fromJson).toList(),
      AnalyticsParse.optionalDecimal(j, 'liquidationTotal'),
      AnalyticsParse.array(j['liquidations'])
          .map(AnalyticsLiquidation.fromJson)
          .toList(),
      insight as String?,
      volumeSeriesByWindow: _windowPoints(j['volumeSeriesByWindow']),
      inflowSeriesByWindow: _windowPoints(j['inflowSeriesByWindow']),
      liquidationCount: count as int?,
      stale: j['stale'] == true,
    );
  }

  static Map<String, List<AnalyticsPoint>> _windowPoints(Object? raw) {
    if (raw == null) return const {};
    return AnalyticsParse.object(raw).map((key, value) => MapEntry(key,
        AnalyticsParse.array(value).map(AnalyticsPoint.fromJson).toList()));
  }
}

class AnalyticsMarketDetail {
  const AnalyticsMarketDetail(this.symbol, this.asOf, this.priceSeries,
      this.longShare, this.fundingHistory, this.liquidations,
      {this.stale = false});
  final String symbol;
  final String? longShare;
  final bool stale;
  final DateTime asOf;
  final List<AnalyticsPoint> priceSeries, fundingHistory;
  final List<AnalyticsLiquidation> liquidations;
  factory AnalyticsMarketDetail.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsMarketDetail(
      AnalyticsParse.string(j, 'symbol'),
      AnalyticsParse.time(j, 'asOf'),
      AnalyticsParse.array(j['priceSeries'])
          .map(AnalyticsPoint.fromJson)
          .toList(),
      AnalyticsParse.optionalDecimal(j, 'longShare'),
      AnalyticsParse.array(j['fundingHistory'])
          .map(AnalyticsPoint.fromJson)
          .toList(),
      AnalyticsParse.array(j['liquidations'])
          .map(AnalyticsLiquidation.fromJson)
          .toList(),
      stale: j['stale'] == true,
    );
  }
}

class AnalyticsMargin {
  const AnalyticsMargin(this.equity, this.available, this.maintenance,
      {this.balance, this.locked});
  final String? equity, available, maintenance, balance, locked;
  factory AnalyticsMargin.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsMargin(
      AnalyticsParse.optionalDecimal(j, 'equity'),
      AnalyticsParse.optionalDecimal(j, 'available'),
      AnalyticsParse.optionalDecimal(j, 'maintenance'),
      balance: AnalyticsParse.optionalDecimal(j, 'balance'),
      locked: AnalyticsParse.optionalDecimal(j, 'locked'),
    );
  }
}

class AnalyticsPosition {
  const AnalyticsPosition(
    this.market,
    this.side,
    this.size,
    this.entry,
    this.leverage,
    this.unrealizedPnl,
    this.liquidationPrice,
    this.liquidationDistance,
  );
  final String market, side, size, entry, leverage;
  final String? unrealizedPnl, liquidationPrice, liquidationDistance;
  factory AnalyticsPosition.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsPosition(
      AnalyticsParse.string(j, 'market'),
      AnalyticsParse.string(j, 'side'),
      AnalyticsParse.decimal(j, 'size'),
      AnalyticsParse.decimal(j, 'entry'),
      AnalyticsParse.decimal(j, 'leverage'),
      AnalyticsParse.optionalDecimal(j, 'unrealizedPnl'),
      AnalyticsParse.optionalDecimal(j, 'liquidationPrice'),
      AnalyticsParse.optionalDecimal(j, 'liquidationDistance'),
    );
  }
}

class AnalyticsPerformance {
  const AnalyticsPerformance(
    this.winRate,
    this.profitFactor,
    this.maxDrawdown,
    this.currentStreak,
    this.averageHoldHours,
    this.bestMarket,
    this.worstMarket,
    this.equitySeries,
  );
  final String currentStreak;
  final String? winRate,
      profitFactor,
      maxDrawdown,
      averageHoldHours,
      bestMarket,
      worstMarket;
  final List<AnalyticsPoint> equitySeries;
  factory AnalyticsPerformance.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsPerformance(
      AnalyticsParse.optionalDecimal(j, 'winRate'),
      AnalyticsParse.optionalDecimal(j, 'profitFactor'),
      AnalyticsParse.optionalDecimal(j, 'maxDrawdown'),
      AnalyticsParse.decimal(j, 'currentStreak'),
      AnalyticsParse.optionalDecimal(j, 'averageHoldHours'),
      AnalyticsParse.optionalString(j, 'bestMarket'),
      AnalyticsParse.optionalString(j, 'worstMarket'),
      AnalyticsParse.array(j['equitySeries'])
          .map(AnalyticsPoint.fromJson)
          .toList(),
    );
  }
}

class AnalyticsWallet {
  const AnalyticsWallet(
      this.address, this.asOf, this.margin, this.positions, this.performance,
      {this.stale = false});
  final String address;
  final DateTime asOf;
  final AnalyticsMargin margin;
  final List<AnalyticsPosition> positions;
  final AnalyticsPerformance performance;
  final bool stale;
  factory AnalyticsWallet.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    final address = AnalyticsParse.string(j, 'address');
    if (!isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    return AnalyticsWallet(
      address,
      AnalyticsParse.time(j, 'asOf'),
      AnalyticsMargin.fromJson(j['margin']),
      AnalyticsParse.array(j['positions'])
          .map(AnalyticsPosition.fromJson)
          .toList(),
      AnalyticsPerformance.fromJson(j['performance']),
      stale: j['stale'] == true,
    );
  }
}

class AnalyticsTrade {
  const AnalyticsTrade(
    this.id,
    this.at,
    this.market,
    this.side,
    this.size,
    this.realizedPnl,
  );
  final String id, market, side, size;
  final String? realizedPnl;
  final DateTime at;
  factory AnalyticsTrade.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return AnalyticsTrade(
      AnalyticsParse.string(j, 'id'),
      AnalyticsParse.time(j, 'at'),
      AnalyticsParse.string(j, 'market'),
      AnalyticsParse.string(j, 'side'),
      AnalyticsParse.decimal(j, 'size'),
      AnalyticsParse.optionalDecimal(j, 'realizedPnl'),
    );
  }
}

class AnalyticsTradePage {
  const AnalyticsTradePage(this.rows, this.nextCursor);
  final List<AnalyticsTrade> rows;
  final String? nextCursor;
  factory AnalyticsTradePage.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    final cursor = j['nextCursor'];
    if (cursor != null && cursor is! String) {
      throw const FormatException('Invalid nextCursor');
    }
    return AnalyticsTradePage(
      AnalyticsParse.array(j['rows']).map(AnalyticsTrade.fromJson).toList(),
      cursor as String?,
    );
  }
}
