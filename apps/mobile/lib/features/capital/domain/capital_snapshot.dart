const _defaultCollateralAsset =
    String.fromEnvironment('EYELER_DEPLOYMENT', defaultValue: 'testnet') ==
            'mainnet'
        ? 'AUSD'
        : 'USD';

class CapitalAmount {
  const CapitalAmount(
      {required this.amount,
      required this.asset,
      required this.decimals,
      required this.source,
      required this.availability,
      required this.freshness,
      this.ageMs,
      this.updatedAt,
      this.reason});
  final String? amount;
  final String asset;
  final int decimals;
  final String source;
  final String availability;
  final String freshness;
  final int? ageMs;
  final DateTime? updatedAt;
  final String? reason;
  bool get isAvailable => availability == 'AVAILABLE' && amount != null;
  double? get numeric => amount == null ? null : double.tryParse(amount!);

  factory CapitalAmount.fromJson(Object? value,
      {required String asset,
      required String source,
      int decimals = 6,
      String? fallbackReason}) {
    if (value is! Map) {
      return CapitalAmount(
          amount: _text(value),
          asset: asset,
          decimals: decimals,
          source: source,
          availability: _text(value) == null ? 'UNAVAILABLE' : 'AVAILABLE',
          freshness: _text(value) == null ? 'UNKNOWN' : 'UNKNOWN',
          reason: fallbackReason);
    }
    final map = Map<String, dynamic>.from(value);
    final parsed = _text(map['amount']);
    return CapitalAmount(
        amount: parsed,
        asset: map['asset'] as String? ?? asset,
        decimals: (map['decimals'] as num?)?.toInt() ?? decimals,
        source: map['source'] == 'KEEL_LEDGER'
            ? 'EYELER_LEDGER'
            : (map['source'] as String? ?? source),
        availability: map['availability'] as String? ??
            (parsed == null ? 'UNAVAILABLE' : 'AVAILABLE'),
        freshness: map['freshness'] as String? ?? 'UNKNOWN',
        ageMs: (map['ageMs'] as num?)?.toInt(),
        updatedAt: _date(map['updatedAt']),
        reason: map['reason'] as String? ?? fallbackReason);
  }
}

class CapitalSnapshot {
  const CapitalSnapshot(
      {required this.status,
      required this.walletAusd,
      required this.walletAgoraAusd,
      required this.perplAvailable,
      required this.perplLocked,
      required this.bookReserved,
      required this.bookDeployed,
      required this.bookRemaining,
      required this.unreservedCapital,
      this.reserveCoverage,
      this.bookAllocations = const [],
      this.ausdMetrics,
      this.accountId});
  final String status;
  final int? accountId;
  final CapitalAmount walletAusd;
  final CapitalAmount walletAgoraAusd;
  final CapitalAmount perplAvailable;
  final CapitalAmount perplLocked;
  final CapitalAmount bookReserved;
  final CapitalAmount bookDeployed;
  final CapitalAmount bookRemaining;
  final CapitalAmount unreservedCapital;
  final Map<String, String>? reserveCoverage;
  final List<Map<String, String>> bookAllocations;
  final AusdMetrics? ausdMetrics;
  String? get ausdBalance => walletAusd.amount;
  factory CapitalSnapshot.fromJson(Map<String, dynamic> json) => CapitalSnapshot(
      status: json['status'] as String? ?? 'UNAVAILABLE',
      accountId: (json['accountId'] as num?)?.toInt(),
      reserveCoverage: json['reserveCoverage'] is Map
          ? Map<String, String>.from(json['reserveCoverage'] as Map)
          : null,
      bookAllocations: (json['bookAllocations'] as List? ?? const [])
          .whereType<Map>()
          .map((row) => Map<String, String>.from(row))
          .toList(),
      ausdMetrics: json['ausdMetrics'] is Map
          ? AusdMetrics.fromJson(
              Map<String, dynamic>.from(json['ausdMetrics'] as Map))
          : null,
      walletAusd: CapitalAmount.fromJson(
          json['walletAusd'] ?? json['ausdBalance'],
          asset: _defaultCollateralAsset,
          source: 'MONAD_AUSD',
          fallbackReason: json['walletAusd'] == null
              ? 'WALLET_BALANCE_NOT_RETURNED'
              : null),
      walletAgoraAusd: CapitalAmount.fromJson(json['walletAgoraAusd'],
          asset: 'AUSD',
          source: 'MONAD_AGORA_AUSD',
          fallbackReason: 'MONAD_AGORA_AUSD_READ_FAILED'),
      perplAvailable: CapitalAmount.fromJson(json['perplAvailable'],
          asset: _defaultCollateralAsset, source: 'PERPL_COLLATERAL'),
      perplLocked: CapitalAmount.fromJson(json['perplLocked'],
          asset: _defaultCollateralAsset, source: 'PERPL_COLLATERAL'),
      bookReserved: CapitalAmount.fromJson(json['bookReserved'],
          asset: _defaultCollateralAsset, source: 'EYELER_LEDGER'),
      bookDeployed: CapitalAmount.fromJson(json['bookDeployed'],
          asset: _defaultCollateralAsset, source: 'EYELER_LEDGER'),
      bookRemaining: CapitalAmount.fromJson(json['bookRemaining'],
          asset: _defaultCollateralAsset, source: 'EYELER_LEDGER'),
      unreservedCapital: CapitalAmount.fromJson(json['unreservedCapital'], asset: _defaultCollateralAsset, source: 'EYELER_LEDGER'));
}

class AusdMetrics {
  const AusdMetrics({required this.status, this.supply, this.reason});
  final String status;
  final String? supply;
  final String? reason;
  factory AusdMetrics.fromJson(Map<String, dynamic> json) => AusdMetrics(
      status: json['status'] as String? ?? 'UNAVAILABLE',
      supply: json['supply'] as String?,
      reason: json['reason'] as String?);
}

String? _text(Object? value) => value is num
    ? value.toString()
    : value is String
        ? value
        : null;
DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;

class AgoraActivityRow {
  const AgoraActivityRow(
      {this.id,
      required this.type,
      required this.status,
      required this.source,
      required this.destination,
      required this.asset,
      required this.amount,
      required this.timestamp,
      required this.match,
      this.transactionHash});
  final String type;
  final String? id;
  final String status;
  final String source;
  final String destination;
  final String asset;
  final String amount;
  final DateTime? timestamp;
  final String match;
  final String? transactionHash;
  factory AgoraActivityRow.fromJson(Map<String, dynamic> json) =>
      AgoraActivityRow(
          id: json['id'] as String?,
          type: json['type'] as String? ?? 'Activity',
          status: json['status'] as String? ?? 'Unknown',
          source: json['source'] as String? ?? 'Unknown',
          destination: json['destination'] as String? ?? 'Unknown',
          asset: json['asset'] as String? ?? 'Unknown',
          amount: json['amount'] as String? ?? '',
          timestamp: _date(json['timestamp']),
          match: json['match'] as String? ?? 'UNMATCHED',
          transactionHash: json['transactionHash'] as String?);
}

class AgoraActivity {
  const AgoraActivity(
      {required this.status,
      required this.rows,
      this.reason,
      this.limited,
      this.nextCursor,
      this.checkedAt});
  final String status;
  final String? reason;
  final bool? limited;
  final String? nextCursor;
  final DateTime? checkedAt;
  final List<AgoraActivityRow> rows;
  factory AgoraActivity.fromJson(Map<String, dynamic> json) => AgoraActivity(
      status: json['status'] as String? ?? 'UNAVAILABLE',
      reason: json['reason'] as String?,
      limited: json['limited'] as bool?,
      nextCursor: json['nextCursor'] as String?,
      checkedAt: _date(json['checkedAt']),
      rows: (json['rows'] as List? ?? const [])
          .whereType<Map>()
          .map((row) =>
              AgoraActivityRow.fromJson(Map<String, dynamic>.from(row)))
          .toList());
}
