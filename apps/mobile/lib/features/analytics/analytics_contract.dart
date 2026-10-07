import 'analytics_models.dart';

/// Typed public analytics v1 contract. Nullable quantities stay nullable.
abstract final class V1 {
  static int integer(Map<String, dynamic> j, String key) {
    final value = j[key];
    if (value is! int) throw FormatException('Invalid $key');
    return value;
  }

  static int? optionalInteger(Map<String, dynamic> j, String key) =>
      j[key] == null ? null : integer(j, key);

  static bool boolean(Map<String, dynamic> j, String key) {
    final value = j[key];
    if (value is! bool) throw FormatException('Invalid $key');
    return value;
  }

  static String oneOf(Map<String, dynamic> j, String key, Set<String> values) {
    final value = AnalyticsParse.string(j, key);
    if (!values.contains(value)) throw FormatException('Invalid $key');
    return value;
  }

  static String? optionalOneOf(
          Map<String, dynamic> j, String key, Set<String> values) =>
      j[key] == null ? null : oneOf(j, key, values);

  static List<T> list<T>(
          Map<String, dynamic> j, String key, T Function(Object?) parse) =>
      AnalyticsParse.array(j[key]).map(parse).toList();

  static String address(Map<String, dynamic> j, String key) {
    final value = AnalyticsParse.string(j, key);
    if (!isAnalyticsAddress(value)) throw FormatException('Invalid $key');
    return value;
  }
}

class V1Envelope<T> {
  const V1Envelope(this.asOf, this.block, this.source, this.stale, this.data);
  final DateTime asOf;
  final int? block;
  final String source;
  final bool stale;
  final T data;

  factory V1Envelope.fromJson(Object? raw, T Function(Object?) parse) {
    final j = AnalyticsParse.object(raw);
    return V1Envelope(
      AnalyticsParse.time(j, 'asOf'),
      V1.optionalInteger(j, 'block'),
      V1.oneOf(
          j, 'source', {'perpl_api', 'monad_exchange', 'derived', 'external'}),
      V1.boolean(j, 'stale'),
      parse(j['data']),
    );
  }
}

class V1WindowValue {
  const V1WindowValue(this.value, this.previous, this.changePct);
  final String? value, previous, changePct;
  factory V1WindowValue.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1WindowValue(
        AnalyticsParse.optionalDecimal(j, 'value'),
        AnalyticsParse.optionalDecimal(j, 'previous'),
        AnalyticsParse.optionalDecimal(j, 'changePct'));
  }
}

class V1ProtocolSummary {
  const V1ProtocolSummary(this.window, this.metrics);
  final String window;
  final Map<String, V1WindowValue> metrics;
  factory V1ProtocolSummary.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    final metrics = <String, V1WindowValue>{};
    for (final key in [
      'volume',
      'fees',
      'revenue',
      'activeUsers',
      'liquidations',
      'openInterest',
      'tvl',
      'netFlows'
    ]) {
      metrics[key] = V1WindowValue.fromJson(j[key]);
    }
    return V1ProtocolSummary(
        V1.oneOf(j, 'window', {'24h', '7d', '30d', 'all'}), metrics);
  }
}

class V1TimePoint {
  const V1TimePoint(this.time, this.value);
  final DateTime time;
  final String? value;
  factory V1TimePoint.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1TimePoint(AnalyticsParse.time(j, 'time'),
        AnalyticsParse.optionalDecimal(j, 'value'));
  }

  AnalyticsPoint toView() => AnalyticsPoint(time, value);
}

class V1Timeseries {
  const V1Timeseries(
      this.metric, this.interval, this.from, this.to, this.points);
  final String metric, interval;
  final DateTime from, to;
  final List<V1TimePoint> points;
  factory V1Timeseries.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1Timeseries(
      V1.oneOf(j, 'metric',
          {'volume', 'oi', 'tvl', 'fees', 'active_users', 'net_flows'}),
      V1.oneOf(j, 'interval', {'1h', '1d'}),
      AnalyticsParse.time(j, 'from'),
      AnalyticsParse.time(j, 'to'),
      V1.list(j, 'points', V1TimePoint.fromJson),
    );
  }
}

class V1FlowBucket {
  const V1FlowBucket(this.time, this.deposits, this.withdrawals, this.net);
  final DateTime time;
  final String deposits, withdrawals, net;
  factory V1FlowBucket.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1FlowBucket(
        AnalyticsParse.time(j, 'time'),
        AnalyticsParse.decimal(j, 'deposits'),
        AnalyticsParse.decimal(j, 'withdrawals'),
        AnalyticsParse.decimal(j, 'net'));
  }
}

class V1Flows {
  const V1Flows(
      this.window, this.deposits, this.withdrawals, this.net, this.buckets);
  final String window;
  final String? deposits, withdrawals, net;
  final List<V1FlowBucket> buckets;
  factory V1Flows.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1Flows(
        V1.oneOf(j, 'window', {'24h', '7d', '30d', 'all'}),
        AnalyticsParse.optionalDecimal(j, 'deposits'),
        AnalyticsParse.optionalDecimal(j, 'withdrawals'),
        AnalyticsParse.optionalDecimal(j, 'net'),
        V1.list(j, 'buckets', V1FlowBucket.fromJson));
  }
}

class V1Market {
  const V1Market(
      this.id,
      this.symbol,
      this.volume24h,
      this.openInterest,
      this.longOpenInterest,
      this.shortOpenInterest,
      this.longSharePct,
      this.fundingRate,
      this.markPrice);
  final int id;
  final String symbol;
  final String? volume24h,
      openInterest,
      longOpenInterest,
      shortOpenInterest,
      longSharePct,
      fundingRate,
      markPrice;
  factory V1Market.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1Market(
        V1.integer(j, 'id'),
        AnalyticsParse.string(j, 'symbol'),
        AnalyticsParse.optionalDecimal(j, 'volume24h'),
        AnalyticsParse.optionalDecimal(j, 'openInterest'),
        AnalyticsParse.optionalDecimal(j, 'longOpenInterest'),
        AnalyticsParse.optionalDecimal(j, 'shortOpenInterest'),
        AnalyticsParse.optionalDecimal(j, 'longSharePct'),
        AnalyticsParse.optionalDecimal(j, 'fundingRate'),
        AnalyticsParse.optionalDecimal(j, 'markPrice'));
  }
}

class V1MarketDetail {
  const V1MarketDetail(this.market, this.tvl, this.priceDecimals,
      this.sizeDecimals, this.fundingIntervalSeconds);
  final V1Market market;
  final String? tvl;
  final int priceDecimals, sizeDecimals, fundingIntervalSeconds;
  factory V1MarketDetail.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1MarketDetail(
        V1Market.fromJson(j),
        AnalyticsParse.optionalDecimal(j, 'tvl'),
        V1.integer(j, 'priceDecimals'),
        V1.integer(j, 'sizeDecimals'),
        V1.integer(j, 'fundingIntervalSeconds'));
  }
}

class V1FundingPoint {
  const V1FundingPoint(this.time, this.block, this.rate);
  final DateTime time;
  final int? block;
  final String rate;
  factory V1FundingPoint.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1FundingPoint(AnalyticsParse.time(j, 'time'),
        V1.optionalInteger(j, 'block'), AnalyticsParse.decimal(j, 'rate'));
  }
}

class V1MarketFunding {
  const V1MarketFunding(this.marketId, this.points);
  final int marketId;
  final List<V1FundingPoint> points;
  factory V1MarketFunding.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1MarketFunding(V1.integer(j, 'marketId'),
        V1.list(j, 'points', V1FundingPoint.fromJson));
  }
}

class V1Liquidation {
  const V1Liquidation(this.id, this.time, this.marketId, this.address,
      this.side, this.notional, this.realizedPnl, this.transactionHash);
  final String id, transactionHash;
  final DateTime time;
  final int marketId;
  final String? address, side, notional, realizedPnl;
  factory V1Liquidation.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    final address = AnalyticsParse.optionalString(j, 'address');
    if (address != null && !isAnalyticsAddress(address)) {
      throw const FormatException('Invalid liquidation address');
    }
    return V1Liquidation(
        AnalyticsParse.string(j, 'id'),
        AnalyticsParse.time(j, 'time'),
        V1.integer(j, 'marketId'),
        address,
        V1.optionalOneOf(j, 'side', {'long', 'short'}),
        AnalyticsParse.optionalDecimal(j, 'notional'),
        AnalyticsParse.optionalDecimal(j, 'realizedPnl'),
        AnalyticsParse.string(j, 'transactionHash'));
  }
}

class V1LiquidationPage {
  const V1LiquidationPage(
      this.items, this.nextCursor, this.count, this.notional);
  final List<V1Liquidation> items;
  final String? nextCursor, notional;
  final int count;
  factory V1LiquidationPage.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    final summary = AnalyticsParse.object(j['summary']);
    return V1LiquidationPage(
        V1.list(j, 'items', V1Liquidation.fromJson),
        AnalyticsParse.optionalString(j, 'nextCursor'),
        V1.integer(summary, 'count'),
        AnalyticsParse.optionalDecimal(summary, 'notional'));
  }
}

class V1SearchMatch {
  const V1SearchMatch(this.address, this.accountId);
  final String address;
  final String? accountId;
  factory V1SearchMatch.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1SearchMatch(V1.address(j, 'address'),
        AnalyticsParse.optionalString(j, 'accountId'));
  }
}

class V1Search {
  const V1Search(this.items);
  final List<V1SearchMatch> items;
  factory V1Search.fromJson(Object? raw) => V1Search(
      V1.list(AnalyticsParse.object(raw), 'items', V1SearchMatch.fromJson));
}

class V1Margin {
  const V1Margin(this.balance, this.locked, this.free, this.equity);
  final String? balance, locked, free, equity;
  factory V1Margin.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1Margin(
        AnalyticsParse.optionalDecimal(j, 'balance'),
        AnalyticsParse.optionalDecimal(j, 'locked'),
        AnalyticsParse.optionalDecimal(j, 'free'),
        AnalyticsParse.optionalDecimal(j, 'equity'));
  }
}

class V1Position {
  const V1Position(
      this.id,
      this.marketId,
      this.symbol,
      this.side,
      this.size,
      this.notional,
      this.entryPrice,
      this.markPrice,
      this.leverage,
      this.collateral,
      this.unrealizedPnl,
      this.liquidationPrice,
      this.openedAt);
  final String id, symbol, side, size, entryPrice, leverage, collateral;
  final int marketId;
  final String? notional, markPrice, unrealizedPnl, liquidationPrice;
  final DateTime openedAt;
  factory V1Position.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1Position(
        AnalyticsParse.string(j, 'id'),
        V1.integer(j, 'marketId'),
        AnalyticsParse.string(j, 'symbol'),
        V1.oneOf(j, 'side', {'long', 'short'}),
        AnalyticsParse.decimal(j, 'size'),
        AnalyticsParse.optionalDecimal(j, 'notional'),
        AnalyticsParse.decimal(j, 'entryPrice'),
        AnalyticsParse.optionalDecimal(j, 'markPrice'),
        AnalyticsParse.decimal(j, 'leverage'),
        AnalyticsParse.decimal(j, 'collateral'),
        AnalyticsParse.optionalDecimal(j, 'unrealizedPnl'),
        AnalyticsParse.optionalDecimal(j, 'liquidationPrice'),
        AnalyticsParse.time(j, 'openedAt'));
  }
}

class V1WalletProfile {
  const V1WalletProfile(
      this.address, this.accountIds, this.margin, this.positions);
  final String address;
  final List<String> accountIds;
  final V1Margin margin;
  final List<V1Position> positions;
  factory V1WalletProfile.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1WalletProfile(
        V1.address(j, 'address'),
        V1.list(j, 'accountIds', (raw) {
          if (raw is! String || raw.isEmpty) {
            throw const FormatException('Invalid accountId');
          }
          return raw;
        }),
        V1Margin.fromJson(j['margin']),
        V1.list(j, 'positions', V1Position.fromJson));
  }
}

class V1Trade {
  const V1Trade(
      this.id,
      this.time,
      this.marketId,
      this.side,
      this.action,
      this.size,
      this.price,
      this.notional,
      this.fee,
      this.realizedPnl,
      this.transactionHash);
  final String id, side, action, size, price, notional, transactionHash;
  final DateTime time;
  final int marketId;
  final String? fee, realizedPnl;
  factory V1Trade.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1Trade(
        AnalyticsParse.string(j, 'id'),
        AnalyticsParse.time(j, 'time'),
        V1.integer(j, 'marketId'),
        V1.oneOf(j, 'side', {'long', 'short'}),
        V1.oneOf(j, 'action',
            {'open', 'increase', 'reduce', 'close', 'liquidation'}),
        AnalyticsParse.decimal(j, 'size'),
        AnalyticsParse.decimal(j, 'price'),
        AnalyticsParse.decimal(j, 'notional'),
        AnalyticsParse.optionalDecimal(j, 'fee'),
        AnalyticsParse.optionalDecimal(j, 'realizedPnl'),
        AnalyticsParse.string(j, 'transactionHash'));
  }
}

class V1TradePage {
  const V1TradePage(this.items, this.nextCursor);
  final List<V1Trade> items;
  final String? nextCursor;
  factory V1TradePage.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1TradePage(V1.list(j, 'items', V1Trade.fromJson),
        AnalyticsParse.optionalString(j, 'nextCursor'));
  }
}

class V1WalletPerformance {
  const V1WalletPerformance(
      this.address,
      this.realizedPnl,
      this.winRatePct,
      this.profitFactor,
      this.maxDrawdownPct,
      this.currentStreak,
      this.longestWinStreak,
      this.longestLossStreak,
      this.averageHoldSeconds,
      this.bestMarketId,
      this.worstMarketId,
      this.closedTrades,
      this.equityCurve);
  final String address;
  final String? realizedPnl, winRatePct, profitFactor, maxDrawdownPct;
  final int currentStreak, longestWinStreak, longestLossStreak, closedTrades;
  final int? averageHoldSeconds, bestMarketId, worstMarketId;
  final List<V1TimePoint> equityCurve;
  factory V1WalletPerformance.fromJson(Object? raw) {
    final j = AnalyticsParse.object(raw);
    return V1WalletPerformance(
        V1.address(j, 'address'),
        AnalyticsParse.optionalDecimal(j, 'realizedPnl'),
        AnalyticsParse.optionalDecimal(j, 'winRatePct'),
        AnalyticsParse.optionalDecimal(j, 'profitFactor'),
        AnalyticsParse.optionalDecimal(j, 'maxDrawdownPct'),
        V1.integer(j, 'currentStreak'),
        V1.integer(j, 'longestWinStreak'),
        V1.integer(j, 'longestLossStreak'),
        V1.optionalInteger(j, 'averageHoldSeconds'),
        V1.optionalInteger(j, 'bestMarketId'),
        V1.optionalInteger(j, 'worstMarketId'),
        V1.integer(j, 'closedTrades'),
        V1.list(j, 'equityCurve', V1TimePoint.fromJson));
  }
}

class V1WalletCompare {
  const V1WalletCompare(this.wallets);
  final List<V1WalletPerformance> wallets;
  factory V1WalletCompare.fromJson(Object? raw) => V1WalletCompare(V1.list(
      AnalyticsParse.object(raw), 'wallets', V1WalletPerformance.fromJson));
}
