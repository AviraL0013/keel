class AutopsyEvent {
  const AutopsyEvent(
      {required this.id,
      required this.type,
      required this.timestamp,
      this.decision,
      this.reason,
      this.action,
      this.venueResult,
      this.postState,
      this.reserveEffect,
      this.venueProgress,
      this.transactionHash});
  final String id, type, timestamp;
  final String? decision, reason, action;
  final String? venueResult, postState, reserveEffect;
  final Map<String, dynamic>? venueProgress;
  final String? transactionHash;
  factory AutopsyEvent.fromJson(Map<String, dynamic> json) => AutopsyEvent(
      id: json['id'] as String? ?? '${json['type']}-${json['timestamp']}',
      type: json['type'] as String? ?? 'EVENT',
      timestamp: json['timestamp'] as String? ?? '',
      decision: _text(json['decision']),
      reason: _text(json['reason']),
      action: _text(json['action']),
      venueResult: _text(json['venueResult']),
      postState: _text(json['postState']),
      reserveEffect: _text(json['reserveEffect']),
      venueProgress: json['venueProgress'] is Map
          ? Map<String, dynamic>.from(json['venueProgress'] as Map)
          : null,
      transactionHash: _text(json['transactionHash']));
}

String? _text(Object? value) => value == null
    ? null
    : value is String
        ? value
        : value is Map
            ? value.entries
                .map((entry) => '${entry.key}: ${entry.value}')
                .join(', ')
            : value.toString();
