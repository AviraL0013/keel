import '../../../shared/models/telemetry_freshness.dart';

class Book {
  const Book(
      {required this.id,
      required this.market,
      required this.side,
      required this.stance,
      required this.status,
      required this.automationEnabled,
      required this.liquidationFloor,
      required this.defenseCap,
      required this.timeLimitMs});
  final String id, market, side, stance, status;
  final bool automationEnabled;
  final double liquidationFloor, defenseCap;
  final int timeLimitMs;
  factory Book.fromJson(Map<String, dynamic> json) => Book(
      id: json['id'] as String,
      market: json['market'] as String,
      side: json['side'] as String,
      stance: json['stance'] as String,
      status: json['status'] as String,
      automationEnabled: json['automationEnabled'] as bool,
      liquidationFloor: (json['liquidationFloor'] as num).toDouble(),
      defenseCap: (json['defenseCap'] as num).toDouble(),
      timeLimitMs: (json['timeLimitMs'] as num).toInt());
}

class BookTelemetry {
  const BookTelemetry(
      {this.size,
      this.entryPrice,
      this.mark,
      this.oracle,
      this.bid,
      this.ask,
      this.pnl,
      this.leverage,
      this.margin,
      this.liquidationPrice,
      this.fundingRate,
      this.depthNotional,
      this.reserveAvailable,
      this.reserveDeployed,
      this.freshnessMs,
      this.freshness,
      this.riskState,
      this.riskStatus,
      this.riskReason,
      this.reasonCodes = const [],
      this.reasons = const [],
      this.executionState,
      this.executionReason,
      this.executionActionId,
      this.liquidationDistance,
      this.positionStatus});
  final double? size,
      entryPrice,
      mark,
      oracle,
      bid,
      ask,
      pnl,
      leverage,
      margin,
      liquidationPrice,
      fundingRate,
      depthNotional,
      reserveAvailable,
      reserveDeployed;
  final double? liquidationDistance;
  final int? freshnessMs;
  final TelemetryFreshnessModel? freshness;
  final String? riskState, riskStatus, riskReason, executionState, executionReason, executionActionId, positionStatus;
  final List<String> reasonCodes;
  final List<String> reasons;
  bool get stale {
    final value = freshness;
    return value != null &&
        [value.market, value.position, value.funding, value.orderbook]
            .any((point) => point.stale);
  }
  bool get freshnessUnknown =>
      freshness == null ||
      [freshness!.market, freshness!.position, freshness!.funding, freshness!.orderbook]
          .any((point) => point.status == 'UNKNOWN');
}

class BookDashboardState {
  const BookDashboardState({required this.book, required this.telemetry});
  final Book book;
  final BookTelemetry telemetry;
}

class BookConfiguration {
  const BookConfiguration(
      {required this.liquidationFloor,
      required this.defenseCap,
      required this.reserve,
      required this.timeLimit,
      required this.stance,
      required this.automation});
  final double liquidationFloor, defenseCap, reserve;
  final Duration timeLimit;
  final String? stance;
  final bool automation;
  String? validate() {
    if (!liquidationFloor.isFinite || liquidationFloor <= 0 || liquidationFloor > 100)
      return 'Liquidation floor must be between 0 and 100.';
    if (!defenseCap.isFinite || defenseCap <= 0) return 'Defense cap must be positive.';
    if (!reserve.isFinite || reserve < 0) return 'Reserve cannot be negative.';
    if (defenseCap > reserve) return 'Defense cap cannot exceed reserve.';
    if (timeLimit <= Duration.zero) return 'Time limit must be positive.';
    if (stance == null) return 'Choose a stance.';
    return null;
  }
}
