class EyelerException implements Exception {
  const EyelerException(this.message, {this.statusCode, this.policyRejection});
  final String message;
  final int? statusCode;
  final PolicyRejection? policyRejection;
  String get userMessage {
    if (statusCode == 429) {
      return 'Too many requests. Wait a minute and try again.';
    }
    if (message == 'PERPL_NOT_CONNECTED') {
      return 'Perpl positions could not be verified. Continue account setup in Home or refresh the connection.';
    }
    if (message == 'WALLET_NOT_ALLOWED') {
      return 'This deployment is limited to approved wallets. Use an approved wallet or ask the operator to enable your wallet.';
    }
    if (message == 'WALLET_ALLOWLIST_NOT_CONFIGURED') {
      return 'Wallet access has not been configured on this server.';
    }
    if (message == 'AUTH_CHALLENGE_INVALID') {
      return 'The sign-in request expired or was already used. Sign in again.';
    }
    if (message == 'AUTH_SIGNATURE_INVALID' ||
        message == 'AUTH_MESSAGE_INVALID') {
      return 'The wallet could not verify this sign-in request. Start sign-in again with the same wallet.';
    }
    if (statusCode == 401) {
      return 'Your EYELER session expired. Connect your wallet again.';
    }
    if (message == 'OPENING_DISABLED') {
      return 'Opening trades are not enabled for this account.';
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
    if (message == 'PERPL_FREE_BALANCE_INSUFFICIENT') {
      return 'DEFEND not submitted. Your Perpl account does not have enough free balance.';
    }
    if (message == 'PERPL_FREE_BALANCE_UNAVAILABLE') {
      return 'DEFEND not submitted. Eyeler could not verify a fresh Perpl balance.';
    }
    if (message == 'PERPL_RATE_LIMITED') {
      return 'Perpl is rate limiting EYELER. Live venue data is unavailable; retry after Perpl recovers.';
    }
    if (message == 'POLICY_REJECTED') {
      final reason = policyRejection?.reason;
      return reason != null && reason.isNotEmpty
          ? 'Action not submitted. $reason'
          : 'Action refused by the current backend risk policy. Review the live risk state.';
    }
    if (message == 'BOOK_RECOVERY_REJECTED') {
      final reason = policyRejection?.reason;
      return reason != null && reason.isNotEmpty
          ? 'Book not recovered. $reason'
          : 'Book not recovered. Review current risk state.';
    }
    if (message == 'POSITION_EXECUTION_UNRESOLVED') {
      return 'Book not recovered. An execution for this position still needs reconciliation.';
    }
    if (message == 'VENUE_UNAVAILABLE' ||
        message == 'VENUE_STATE_UNAVAILABLE') {
      return 'Book not recovered. Live Perpl state is unavailable.';
    }
    if (statusCode != null && statusCode! >= 500) {
      return 'EYELER server unavailable. Check the backend and retry.';
    }
    if (message.contains('SocketException') ||
        message.contains('ClientException') ||
        message.contains('Failed to fetch')) {
      return 'EYELER server unavailable. Check the backend and retry.';
    }
    if (message.startsWith('{')) {
      return 'EYELER request failed. Review the current state and retry.';
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

String friendlyError(Object error) => error is EyelerException
    ? error.userMessage
    : 'EYELER server unavailable. Check the backend and retry.';
