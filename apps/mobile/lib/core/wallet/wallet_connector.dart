import 'wallet_connector_stub.dart' if (dart.library.js_util) 'wallet_connector_web.dart';
import 'wallet_types.dart';
export 'wallet_types.dart';
WalletConnector createWalletConnector() => walletConnector();
