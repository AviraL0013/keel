import 'dart:convert';
import 'wallet_types.dart';

typedef WalletRequest = Future<Object?> Function(String method, [List<Object?>? params]);

class Eip1193Exception implements Exception {
  const Eip1193Exception(this.code, [this.detail = '']);
  final int? code;
  final String detail;
  @override
  String toString() => detail.isEmpty ? 'Wallet provider error $code' : detail;
}

class WalletNetworkConfig {
  const WalletNetworkConfig({
    this.chainId = const int.fromEnvironment('KEEL_CHAIN_ID', defaultValue: 10143),
    this.chainName = const String.fromEnvironment('KEEL_CHAIN_NAME', defaultValue: 'Monad Testnet'),
    this.rpcUrl = const String.fromEnvironment('KEEL_MONAD_RPC_URL'),
    this.currencyName = const String.fromEnvironment('KEEL_NATIVE_CURRENCY_NAME', defaultValue: 'Monad'),
    this.currencySymbol = const String.fromEnvironment('KEEL_NATIVE_CURRENCY_SYMBOL', defaultValue: 'MON'),
    this.explorerUrl = const String.fromEnvironment('KEEL_MONAD_EXPLORER_URL'),
  });
  final int chainId;
  final String chainName;
  final String rpcUrl;
  final String currencyName;
  final String currencySymbol;
  final String explorerUrl;
  String get hexChainId => '0x${chainId.toRadixString(16)}';
}

class Eip1193WalletConnector implements WalletConnector {
  Eip1193WalletConnector(this.request, {this.network = const WalletNetworkConfig()});
  final WalletRequest request;
  final WalletNetworkConfig network;

  Future<void> ensureNetwork() async {
    final current = await request('eth_chainId');
    final text = current?.toString();
    final chainId = text != null && text.startsWith('0x') ? int.tryParse(text.substring(2), radix: 16) : null;
    if (chainId == network.chainId) return;
    if (chainId == null) throw const WalletException('Wallet returned an invalid network.');
    try {
      await request('wallet_switchEthereumChain', [{'chainId': network.hexChainId}]);
    } on Eip1193Exception catch (error) {
      if (error.code == 4001) throw WalletException('Switch to ${network.chainName} in your wallet to continue.');
      if (error.code != 4902) throw WalletException('Could not switch wallet to ${network.chainName}.');
      if (network.rpcUrl.isEmpty || network.explorerUrl.isEmpty) throw WalletException('${network.chainName} setup is unavailable. Configure the RPC and explorer URLs.');
      try {
        await request('wallet_addEthereumChain', [{
          'chainId': network.hexChainId,
          'chainName': network.chainName,
          'rpcUrls': [network.rpcUrl],
          'nativeCurrency': {'name': network.currencyName, 'symbol': network.currencySymbol, 'decimals': 18},
          'blockExplorerUrls': [network.explorerUrl],
        }]);
        await request('wallet_switchEthereumChain', [{'chainId': network.hexChainId}]);
      } on Eip1193Exception catch (error) {
        if (error.code == 4001) throw WalletException('Add and switch to ${network.chainName} in your wallet to continue.');
        throw WalletException('Could not add ${network.chainName} to your wallet.');
      }
    }
    final switched = await request('eth_chainId');
    if (switched?.toString().toLowerCase() != network.hexChainId) throw WalletException('Wallet is not connected to ${network.chainName}.');
  }

  @override
  Future<WalletConnection> connect() async {
    final accounts = await request('eth_requestAccounts');
    if (accounts is! List || accounts.isEmpty || accounts.first is! String) throw const WalletException('Wallet returned no account.');
    await ensureNetwork();
    return WalletConnection(address: accounts.first as String, chainId: network.chainId);
  }

  @override
  Future<String> signMessage(String address, String message) async {
    await ensureNetwork();
    final hex = '0x${utf8.encode(message).map((value) => value.toRadixString(16).padLeft(2, '0')).join()}';
    final signature = await request('personal_sign', [hex, address]);
    if (signature is! String || !signature.startsWith('0x')) throw const WalletException('Wallet did not return a signature.');
    return signature;
  }

  @override
  Future<String> signTypedData(String address, Map<String, Object?> typedData) async {
    await ensureNetwork();
    final signature = await request('eth_signTypedData_v4', [address, jsonEncode(typedData)]);
    if (signature is! String || !signature.startsWith('0x')) throw const WalletException('Wallet did not return a typed-data signature.');
    return signature;
  }
}
