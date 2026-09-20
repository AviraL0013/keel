import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../../../core/storage/session_storage.dart';
import '../domain/auth_state.dart';
import '../../../core/wallet/wallet_connector.dart';

class AuthRepository {
  const AuthRepository(this.api);
  final KeelApiClient api;
  Future<Map<String, dynamic>> challenge(String address) =>
      api.post('/auth/challenge',
          body: {'address': address},
          decode: (value) => Map<String, dynamic>.from(value as Map));
  Future<String> verify(
      String address, String nonce, String message, String signature) async {
    final result = await api.post('/auth/verify',
        body: {
          'address': address,
          'nonce': nonce,
          'message': message,
          'signature': signature
        },
        decode: (value) => Map<String, dynamic>.from(value as Map));
    return result['token'] as String;
  }

  Future<void> logout() async {
    await api.post('/auth/logout', decode: (_) => true);
  }
}

final authRepositoryProvider = Provider<AuthRepository>(
    (ref) => AuthRepository(ref.watch(apiClientProvider)));

class AuthController extends StateNotifier<AuthState> {
  AuthController(this.repository, this.storage, this.wallet)
      : super(const AuthState(authenticated: false));
  final AuthRepository repository;
  final SessionStorage storage;
  final WalletConnector wallet;
  Future<void> restore() async {
    state =
        const AuthState(authenticated: false, loading: true, restoring: true);
    final token = await storage.readToken();
    state = AuthState(
        authenticated: token != null,
        walletStatus: token != null
            ? WalletStatus.authenticated
            : WalletStatus.disconnected);
  }

  Future<Map<String, dynamic>> challenge(String address) =>
      repository.challenge(address);
  Future<void> verify(
      String address, String nonce, String message, String signature) async {
    try {
      state = AuthState(
          authenticated: false,
          loading: true,
          address: address,
          challengeMessage: message);
      await storage.saveToken(
          await repository.verify(address, nonce, message, signature));
      state = AuthState(
          authenticated: true,
          address: address,
          walletStatus: WalletStatus.authenticated);
    } catch (error) {
      state = AuthState(
          authenticated: false,
          error: error.toString(),
          address: address,
          challengeMessage: message,
          walletStatus: WalletStatus.error);
    }
  }

  Future<void> connectAndAuthenticate() async {
    try {
      state = const AuthState(
          authenticated: false,
          loading: true,
          walletStatus: WalletStatus.connecting);
      final connection = await wallet.connect();
      state = AuthState(
          authenticated: false,
          loading: true,
          walletStatus: WalletStatus.connected,
          address: connection.address,
          chainId: connection.chainId);
      final challengeResult = await repository.challenge(connection.address);
      state = AuthState(
          authenticated: false,
          loading: true,
          walletStatus: WalletStatus.signing,
          address: connection.address,
          chainId: connection.chainId,
          challengeMessage: challengeResult['message'] as String?);
      final signature = await wallet.signMessage(
          connection.address, challengeResult['message'] as String);
      await storage.saveToken(await repository.verify(
          connection.address,
          challengeResult['nonce'] as String,
          challengeResult['message'] as String,
          signature));
      state = AuthState(
          authenticated: true,
          walletStatus: WalletStatus.authenticated,
          address: connection.address,
          chainId: connection.chainId);
    } catch (error) {
      state = AuthState(
          authenticated: false,
          walletStatus: WalletStatus.error,
          error: error is Exception
              ? error.toString()
              : 'Wallet authentication failed.');
    }
  }

  Future<void> logout() async {
    try {
      await repository.logout();
    } finally {
      await storage.clear();
      state = const AuthState(authenticated: false);
    }
  }
}

final walletConnectorProvider =
    Provider<WalletConnector>((_) => createWalletConnector());
final authProvider = StateNotifierProvider<AuthController, AuthState>((ref) =>
    AuthController(ref.watch(authRepositoryProvider),
        ref.watch(sessionStorageProvider), ref.watch(walletConnectorProvider)));
