import '../../../shared/models/telemetry_freshness.dart';

class Position {
  const Position(
      {required this.marketId,
      required this.accountId,
      required this.market,
      required this.positionId,
      required this.side,
      required this.size,
      required this.entryPrice,
      required this.markPrice,
      required this.liquidationPrice,
      required this.leverage,
      required this.margin,
      required this.status,
      this.liquidationEstimated = false,
      this.pnl,
      this.oracle,
      this.bid,
      this.ask,
      this.mid,
      this.fundingRate,
      this.depthNotional,
      this.freshnessMs,
      this.marketFreshnessMs,
      this.positionFreshnessMs,
      this.fundingFreshnessMs,
      this.orderbookFreshnessMs,
      this.freshness});
  final int marketId, accountId, positionId;
  final String market, side, status;
  final double size, entryPrice, markPrice, liquidationPrice, leverage, margin;
  final bool liquidationEstimated;
  final double? pnl, oracle, bid, ask, mid, fundingRate, depthNotional;
  final int? freshnessMs,
      marketFreshnessMs,
      positionFreshnessMs,
      fundingFreshnessMs,
      orderbookFreshnessMs;
  final TelemetryFreshnessModel? freshness;
  factory Position.fromJson(Map<String, dynamic> json) {
    final value = Map<String, dynamic>.from(json['position'] as Map);
    final telemetry = json['telemetry'] == null
        ? null
        : Map<String, dynamic>.from(json['telemetry'] as Map);
    return Position(
        marketId: (json['marketId'] as num).toInt(),
        accountId: (json['accountId'] as num).toInt(),
        market: json['market'] as String,
        side: value['side'] as String,
        positionId: (json['positionId'] as num).toInt(),
        size: (value['size'] as num).toDouble(),
        entryPrice: (value['entryPrice'] as num).toDouble(),
        markPrice: (value['markPrice'] as num).toDouble(),
        liquidationPrice: (value['liquidationPrice'] as num).toDouble(),
        leverage: (value['leverage'] as num).toDouble(),
        margin: (value['margin'] as num).toDouble(),
        status: value['status'] as String? ?? 'OPEN',
        liquidationEstimated: value['liquidationEstimated'] as bool? ?? false,
        pnl: (value['unrealizedPnl'] as num?)?.toDouble(),
        oracle: (telemetry?['oracle'] as num?)?.toDouble(),
        bid: (telemetry?['bid'] as num?)?.toDouble(),
        ask: (telemetry?['ask'] as num?)?.toDouble(),
        mid: (telemetry?['mid'] as num?)?.toDouble(),
        fundingRate: (telemetry?['fundingRate'] as num?)?.toDouble(),
        depthNotional: (telemetry?['depthNotional'] as num?)?.toDouble(),
        freshnessMs: (telemetry?['freshnessMs'] as num?)?.toInt(),
        marketFreshnessMs: (telemetry?['marketFreshnessMs'] as num?)?.toInt(),
        positionFreshnessMs:
            (telemetry?['positionFreshnessMs'] as num?)?.toInt(),
        fundingFreshnessMs: (telemetry?['fundingFreshnessMs'] as num?)?.toInt(),
        orderbookFreshnessMs:
            (telemetry?['orderbookFreshnessMs'] as num?)?.toInt(),
        freshness: telemetry?['freshness'] == null
            ? null
            : TelemetryFreshnessModel.fromJson(telemetry?['freshness']));
  }
}
