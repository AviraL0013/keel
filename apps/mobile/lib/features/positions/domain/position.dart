class Position {
  const Position({required this.marketId, required this.accountId, required this.market, required this.positionId, required this.side, required this.size, required this.entryPrice, required this.markPrice, required this.liquidationPrice, required this.leverage, required this.margin, required this.status, this.pnl, this.fundingRate, this.depthNotional});
  final int marketId, accountId, positionId;
  final String market, side, status;
  final double size, entryPrice, markPrice, liquidationPrice, leverage, margin;
  final double? pnl, fundingRate, depthNotional;
  factory Position.fromJson(Map<String, dynamic> json) { final value = Map<String, dynamic>.from(json['position'] as Map); final telemetry = json['telemetry'] == null ? null : Map<String, dynamic>.from(json['telemetry'] as Map); return Position(marketId: (json['marketId'] as num).toInt(), accountId: (json['accountId'] as num).toInt(), market: json['market'] as String, positionId: (json['positionId'] as num).toInt(), side: value['side'] as String, size: (value['size'] as num).toDouble(), entryPrice: (value['entryPrice'] as num).toDouble(), markPrice: (value['markPrice'] as num).toDouble(), liquidationPrice: (value['liquidationPrice'] as num).toDouble(), leverage: (value['leverage'] as num).toDouble(), margin: (value['margin'] as num).toDouble(), status: value['status'] as String? ?? 'OPEN', pnl: (value['unrealizedPnl'] as num?)?.toDouble(), fundingRate: (telemetry?['fundingRate'] as num?)?.toDouble(), depthNotional: (telemetry?['depthNotional'] as num?)?.toDouble()); }
}
