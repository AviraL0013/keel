import 'dart:convert';
import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/wallet/wallet_types.dart';
import 'package:eyeler_mobile/features/auth/data/auth_repository.dart';
import 'package:eyeler_mobile/features/auth/domain/auth_state.dart';
import 'package:eyeler_mobile/features/books/data/books_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Storage extends SessionStorage {
  @override
  Future<String?> readToken() async => null;
}

class _Wallet extends WalletConnector {
  @override
  Future<WalletConnection> connect() => throw UnimplementedError();
  @override
  Future<String> signMessage(String address, String message) =>
      throw UnimplementedError();
  @override
  Future<String> signTypedData(
          String address, Map<String, Object?> typedData) =>
      throw UnimplementedError();
}

class _Auth extends AuthController {
  _Auth(EyelerApiClient api)
      : super(AuthRepository(api), _Storage(), _Wallet());
  void login(String address) =>
      state = AuthState(authenticated: true, address: address);
}

void main() {
  test('changing session discards cached Books from the previous wallet',
      () async {
    var owner = 'alice';
    final client = MockClient((_) async => http.Response(
        jsonEncode([
          {
            'id': owner,
            'market': 'BTC',
            'side': 'LONG',
            'stance': 'DEFEND',
            'status': 'ACTIVE',
            'automationEnabled': false,
            'liquidationFloor': 5,
            'defenseCap': 5,
            'timeLimitMs': 1000
          }
        ]),
        200));
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'https://fixture.invalid'),
        _Storage(),
        client);
    final auth = _Auth(api)..login(owner);
    final container = ProviderContainer(overrides: [
      apiClientProvider.overrideWithValue(api),
      authProvider.overrideWith((_) => auth)
    ]);
    addTearDown(container.dispose);
    addTearDown(client.close);
    final subscription = container.listen(booksProvider, (_, __) {});
    addTearDown(subscription.close);
    expect((await container.read(booksProvider.future)).single.id, 'alice');
    owner = 'bob';
    auth.login(owner);
    expect((await container.read(booksProvider.future)).single.id, 'bob');
  });
}
