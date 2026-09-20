import 'wallet_types.dart';

WalletConnector walletConnector() => _UnavailableWalletConnector();

class _UnavailableWalletConnector implements WalletConnector {
  @override
  Future<WalletConnection> connect() => Future.error(const WalletException(
      'No EVM wallet provider is available on this platform.'));
  @override
  Future<String> signMessage(String address, String message) =>
      Future.error(const WalletException(
          'No EVM wallet provider is available on this platform.'));
}
