class CapitalAmount {
  const CapitalAmount({required this.amount, required this.asset, required this.decimals, required this.source, required this.availability, required this.freshness, this.ageMs, this.updatedAt, this.reason});
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

  factory CapitalAmount.fromJson(Object? value, {required String asset, required String source, int decimals = 6, String? fallbackReason}) {
    if (value is! Map) return CapitalAmount(amount: _text(value), asset: asset, decimals: decimals, source: source, availability: _text(value) == null ? 'UNAVAILABLE' : 'AVAILABLE', freshness: _text(value) == null ? 'UNKNOWN' : 'UNKNOWN', reason: fallbackReason);
    final map = Map<String, dynamic>.from(value);
    final parsed = _text(map['amount']);
    return CapitalAmount(amount: parsed, asset: map['asset'] as String? ?? asset, decimals: (map['decimals'] as num?)?.toInt() ?? decimals, source: map['source'] as String? ?? source, availability: map['availability'] as String? ?? (parsed == null ? 'UNAVAILABLE' : 'AVAILABLE'), freshness: map['freshness'] as String? ?? 'UNKNOWN', ageMs: (map['ageMs'] as num?)?.toInt(), updatedAt: _date(map['updatedAt']), reason: map['reason'] as String? ?? fallbackReason);
  }
}

class CapitalSnapshot {
  const CapitalSnapshot({required this.status, required this.walletAusd, required this.perplAvailable, required this.perplLocked, required this.bookReserved, required this.bookDeployed, required this.bookRemaining, required this.unreservedCapital, this.accountId});
  final String status;
  final int? accountId;
  final CapitalAmount walletAusd;
  final CapitalAmount perplAvailable;
  final CapitalAmount perplLocked;
  final CapitalAmount bookReserved;
  final CapitalAmount bookDeployed;
  final CapitalAmount bookRemaining;
  final CapitalAmount unreservedCapital;
  String? get ausdBalance => walletAusd.amount;
  factory CapitalSnapshot.fromJson(Map<String, dynamic> json) => CapitalSnapshot(status: json['status'] as String? ?? 'UNAVAILABLE', accountId: (json['accountId'] as num?)?.toInt(), walletAusd: CapitalAmount.fromJson(json['walletAusd'] ?? json['ausdBalance'], asset: 'AUSD', source: 'MONAD_AUSD', fallbackReason: json['walletAusd'] == null ? 'WALLET_BALANCE_NOT_RETURNED' : null), perplAvailable: CapitalAmount.fromJson(json['perplAvailable'], asset: 'AUSD', source: 'PERPL_COLLATERAL'), perplLocked: CapitalAmount.fromJson(json['perplLocked'], asset: 'AUSD', source: 'PERPL_COLLATERAL'), bookReserved: CapitalAmount.fromJson(json['bookReserved'], asset: 'AUSD', source: 'KEEL_LEDGER'), bookDeployed: CapitalAmount.fromJson(json['bookDeployed'], asset: 'AUSD', source: 'KEEL_LEDGER'), bookRemaining: CapitalAmount.fromJson(json['bookRemaining'], asset: 'AUSD', source: 'KEEL_LEDGER'), unreservedCapital: CapitalAmount.fromJson(json['unreservedCapital'], asset: 'AUSD', source: 'KEEL_LEDGER'));
}

String? _text(Object? value) => value is num ? value.toString() : value is String ? value : null;
DateTime? _date(Object? value) => value is String ? DateTime.tryParse(value) : null;
