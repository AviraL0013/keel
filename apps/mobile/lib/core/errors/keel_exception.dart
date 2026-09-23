class KeelException implements Exception {
  const KeelException(this.message, {this.statusCode, this.policyRejection});
  final String message;
  final int? statusCode;
  final PolicyRejection? policyRejection;
  String get userMessage {
    if (statusCode == 401) {
      return 'Your KEEL session expired. Connect your wallet again.';
    }
    if (message == 'PERPL_ORDER_FORWARDING_DISABLED') {
      return 'Perpl order forwarding is disabled for this account. Enable it in Perpl before submitting actions.';
    }
    if (message == 'PERPL_ACCOUNT_FROZEN') {
      return 'Perpl account is frozen. No action was submitted.';
    }
    if (message == 'PERPL_ACCOUNT_NOT_FOUND') {
      return 'Perpl account is not available to submit this action.';
    }
    if (message == 'POLICY_REJECTED') {
      final reason = policyRejection?.reason;
      return reason != null && reason.isNotEmpty
          ? 'Action not submitted. $reason'
          : 'Action refused by the current backend risk policy. Review the live risk state.';
    }
    if (statusCode != null && statusCode! >= 500) {
      return 'KEEL server unavailable. Check the backend and retry.';
    }
    if (message.contains('SocketException') ||
        message.contains('ClientException') ||
        message.contains('Failed to fetch')) {
      return 'KEEL server unavailable. Check the backend and retry.';
    }
    if (message.startsWith('{')) {
      return 'KEEL request failed. Review the current state and retry.';
    }
    return message;
  }

  @override
  String toString() => message;
}

class PolicyRejection {
  const PolicyRejection({this.state, this.requestedAction, this.reason});
  final String? state;
  final String? requestedAction;
  final String? reason;

  factory PolicyRejection.fromJson(Map<String, dynamic> value) {
    final reasons = value['reasons'];
    return PolicyRejection(
      state: value['state'] is String ? value['state'] as String : null,
      requestedAction: value['requestedAction'] is String
          ? value['requestedAction'] as String
          : null,
      reason: reasons is List ? reasons.whereType<String>().join(' ') : null,
    );
  }
}

String friendlyError(Object error) => error is KeelException
    ? error.userMessage
    : 'KEEL server unavailable. Check the backend and retry.';
