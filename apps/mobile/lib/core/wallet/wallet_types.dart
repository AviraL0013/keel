class WalletConnection {
  const WalletConnection({required this.address, required this.chainId});
  final String address;
  final int chainId;
}

abstract class WalletConnector {
  Future<WalletConnection> connect();
  Future<String> signMessage(String address, String message);
}

class WalletException implements Exception {
  const WalletException(this.message);
  final String message;
  @override
  String toString() => message;
}
