class CapitalSnapshot {
  const CapitalSnapshot(
      {required this.status,
      this.ausdBalance,
      this.perplAvailable,
      this.perplLocked,
      this.bookReserved,
      this.bookDeployed,
      this.bookRemaining,
      this.unreservedCapital});
  final String status;
  final double? ausdBalance,
      perplAvailable,
      perplLocked,
      bookReserved,
      bookDeployed,
      bookRemaining,
      unreservedCapital;
  factory CapitalSnapshot.fromJson(Map<String, dynamic> json) =>
      CapitalSnapshot(
          status: json['status'] as String? ?? 'UNAVAILABLE',
          ausdBalance: _number(json['ausdBalance']),
          perplAvailable: _number(json['perplAvailable']),
          perplLocked: _number(json['perplLocked']),
          bookReserved: _number(json['bookReserved']),
          bookDeployed: _number(json['bookDeployed']),
          bookRemaining: _number(json['bookRemaining']),
          unreservedCapital: _number(json['unreservedCapital']));
}

double? _number(Object? value) => value is num
    ? value.toDouble()
    : value is String
        ? double.tryParse(value)
        : null;
