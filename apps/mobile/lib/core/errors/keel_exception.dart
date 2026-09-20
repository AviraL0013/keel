class KeelException implements Exception {
  const KeelException(this.message, {this.statusCode});
  final String message;
  final int? statusCode;
  String get userMessage {
    if (statusCode == 401)
      return 'Your KEEL session expired. Connect your wallet again.';
    if (statusCode != null && statusCode! >= 500)
      return 'KEEL server unavailable. Check the backend and retry.';
    if (message.contains('SocketException') ||
        message.contains('ClientException') ||
        message.contains('Failed to fetch'))
      return 'KEEL server unavailable. Check the backend and retry.';
    if (message.startsWith('{'))
      return 'KEEL request failed. Review the current state and retry.';
    return message;
  }

  @override
  String toString() => message;
}

String friendlyError(Object error) => error is KeelException
    ? error.userMessage
    : 'KEEL server unavailable. Check the backend and retry.';
