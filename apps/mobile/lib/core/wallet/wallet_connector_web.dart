import 'dart:convert';
import 'dart:js_interop';
import 'wallet_types.dart';

@JS('window.ethereum')
external JSObject? get _ethereum;

extension type _Eip1193(JSObject _) implements JSObject {
  external JSPromise<JSAny?> request(JSAny? request);
}

WalletConnector walletConnector() => _Eip1193WalletConnector();
class _Eip1193WalletConnector implements WalletConnector {
  Future<Object?> _request(String method, [List<String>? params]) async {
    final provider = _ethereum;
    if (provider == null) throw const WalletException('Install or unlock an EVM wallet extension to connect KEEL.');
    final request = <String, Object?>{'method': method, if (params != null) 'params': params}.jsify();
    final result = await (_Eip1193(provider).request(request)).toDart;
    return result?.dartify();
  }
  @override Future<WalletConnection> connect() async {
    final accounts = await _request('eth_requestAccounts');
    if (accounts is! List || accounts.isEmpty || accounts.first is! String) throw const WalletException('Wallet returned no account.');
    final chain = await _request('eth_chainId');
    final chainId = int.tryParse(chain.toString().replaceFirst('0x', ''), radix: 16);
    if (chainId == null) throw const WalletException('Wallet returned an invalid network.');
    return WalletConnection(address: accounts.first as String, chainId: chainId);
  }
  @override Future<String> signMessage(String address, String message) async {
    final hex = '0x${utf8.encode(message).map((value) => value.toRadixString(16).padLeft(2, '0')).join()}';
    final signature = await _request('personal_sign', [hex, address]);
    if (signature is! String || !signature.startsWith('0x')) throw const WalletException('Wallet did not return a signature.');
    return signature;
  }
}
