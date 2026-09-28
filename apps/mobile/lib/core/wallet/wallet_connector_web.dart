import 'dart:js_interop';
import 'dart:js_interop_unsafe';
import 'eip1193_wallet_connector.dart';
import 'wallet_types.dart';

@JS('window.ethereum')
external JSObject? get _ethereum;

extension type _Eip1193(JSObject _) implements JSObject {
  external JSPromise<JSAny?> request(JSAny? request);
}

WalletConnector walletConnector() => Eip1193WalletConnector(_request);

Future<Object?> _request(String method, [List<Object?>? params]) async {
  final provider = _ethereum;
  if (provider == null) throw const WalletException('Install or unlock an EVM wallet extension to connect KEEL.');
  final input = <String, Object?>{'method': method, if (params != null) 'params': params}.jsify();
  try { return (await (_Eip1193(provider).request(input)).toDart)?.dartify(); }
  catch (error) {
    int? code;
    if (error is JSObject) {
      final value = error.getProperty<JSAny?>('code'.toJS)?.dartify();
      if (value is num) code = value.toInt();
    }
    code ??= int.tryParse(RegExp(r'\b(4902|4001)\b').firstMatch(error.toString())?.group(1) ?? '');
    throw Eip1193Exception(code, error.toString());
  }
}
