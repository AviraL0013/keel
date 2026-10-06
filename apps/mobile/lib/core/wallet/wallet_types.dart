class WalletConnection {
  const WalletConnection({required this.address, required this.chainId});
  final String address;
  final int chainId;
}

abstract class WalletConnector {
  bool get supportsAccountCreation => false;
  Future<WalletConnection> createAccount() async => throw const WalletException(
      'Wallet creation is not supported by this provider.');
  Future<WalletConnection> connect();
  Future<String> signMessage(String address, String message);
  Future<String> signTypedData(String address, Map<String, Object?> typedData);

  void dispose() {}
}

class WalletException implements Exception {
  const WalletException(this.message);
  final String message;
  @override
  String toString() => message;
}
