class TelemetryFreshnessPoint {
  static const defaultThresholdMs = 10000;
  const TelemetryFreshnessPoint(
      {required this.status,
      this.source,
      this.updatedAt,
      this.ageMs,
      required this.thresholdMs});

  final String status;
  final String? source;
  final DateTime? updatedAt;
  final int? ageMs;
  final int thresholdMs;

  bool get fresh => status == 'FRESH';
  bool get stale => status == 'STALE';

  factory TelemetryFreshnessPoint.fromJson(Object? raw) {
    final value =
        raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final updated = value['updatedAt'];
    return TelemetryFreshnessPoint(
      status: value['status'] as String? ?? 'UNKNOWN',
      source: value['source'] as String?,
      updatedAt: updated is String
          ? DateTime.tryParse(updated)
          : updated is num
              ? DateTime.fromMillisecondsSinceEpoch(updated.toInt(),
                  isUtc: true)
              : null,
      ageMs: (value['ageMs'] as num?)?.toInt(),
      thresholdMs:
          (value['thresholdMs'] as num?)?.toInt() ?? defaultThresholdMs,
    );
  }
}

class TelemetryFreshnessModel {
  const TelemetryFreshnessModel(
      {required this.market,
      required this.position,
      required this.funding,
      required this.orderbook,
      required this.thresholdsMs});

  final TelemetryFreshnessPoint market;
  final TelemetryFreshnessPoint position;
  final TelemetryFreshnessPoint funding;
  final TelemetryFreshnessPoint orderbook;
  final Map<String, int> thresholdsMs;

  factory TelemetryFreshnessModel.fromJson(Object? raw) {
    final value =
        raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};
    final thresholds = value['thresholdsMs'] is Map
        ? Map<String, dynamic>.from(value['thresholdsMs'] as Map)
        : <String, dynamic>{};
    return TelemetryFreshnessModel(
      market: TelemetryFreshnessPoint.fromJson(value['market']),
      position: TelemetryFreshnessPoint.fromJson(value['position']),
      funding: TelemetryFreshnessPoint.fromJson(value['funding']),
      orderbook: TelemetryFreshnessPoint.fromJson(value['orderbook']),
      thresholdsMs: {
        for (final entry in thresholds.entries)
          entry.key: (entry.value as num?)?.toInt() ??
              TelemetryFreshnessPoint.defaultThresholdMs
      },
    );
  }
}
