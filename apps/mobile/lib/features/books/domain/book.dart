class Book {
  const Book({required this.id, required this.market, required this.side, required this.stance, required this.status, required this.automationEnabled, required this.liquidationFloor, required this.defenseCap, required this.timeLimitMs});
  final String id, market, side, stance, status;
  final bool automationEnabled;
  final double liquidationFloor, defenseCap;
  final int timeLimitMs;
  factory Book.fromJson(Map<String, dynamic> json) => Book(id: json['id'] as String, market: json['market'] as String, side: json['side'] as String, stance: json['stance'] as String, status: json['status'] as String, automationEnabled: json['automationEnabled'] as bool, liquidationFloor: (json['liquidationFloor'] as num).toDouble(), defenseCap: (json['defenseCap'] as num).toDouble(), timeLimitMs: (json['timeLimitMs'] as num).toInt());
}
class BookTelemetry {
  const BookTelemetry({this.size, this.entryPrice, this.mark, this.oracle, this.bid, this.ask, this.pnl, this.leverage, this.margin, this.liquidationPrice, this.fundingRate, this.depthNotional, this.reserveAvailable, this.reserveDeployed, this.freshnessMs, this.riskState, this.reasonCodes = const [], this.reasons = const [], this.executionState, this.positionStatus});
  final double? size, entryPrice, mark, oracle, bid, ask, pnl, leverage, margin, liquidationPrice, fundingRate, depthNotional, reserveAvailable, reserveDeployed;
  final int? freshnessMs;
  final String? riskState, executionState, positionStatus;
  final List<String> reasonCodes;
  final List<String> reasons;
  bool get stale => freshnessMs == null || freshnessMs! > 10000;
}
class BookConfiguration {
  const BookConfiguration({required this.liquidationFloor, required this.defenseCap, required this.reserve, required this.timeLimit, required this.stance, required this.automation});
  final double liquidationFloor, defenseCap, reserve;
  final Duration timeLimit;
  final String? stance;
  final bool automation;
  String? validate() { if (liquidationFloor <= 0 || liquidationFloor > 100) return 'Liquidation floor must be between 0 and 100.'; if (defenseCap <= 0) return 'Defense cap must be positive.'; if (reserve < 0 || reserve > defenseCap) return 'Reserve must be between zero and defense cap.'; if (timeLimit <= Duration.zero) return 'Time limit must be positive.'; if (stance == null) return 'Choose a stance.'; return null; }
}
