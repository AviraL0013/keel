import 'dart:async';
import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _Storage extends SessionStorage {
  String? token = 'alice';
  @override
  Future<String?> readToken() async => token;
  @override
  Future<void> clear() async {
    token = null;
  }
}

void main() {
  test('a late 401 from the previous wallet cannot clear the new session',
      () async {
    final response = Completer<http.Response>();
    final started = Completer<void>();
    final storage = _Storage();
    final client = MockClient((_) {
      started.complete();
      return response.future;
    });
    addTearDown(client.close);
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'https://fixture.invalid'),
        storage,
        client);
    final request = api.get('/books', (value) => value);
    await started.future;
    storage.token = 'bob';
    final assertion = expectLater(request, throwsException);
    response.complete(http.Response('{"error":"UNAUTHENTICATED"}', 401));
    await assertion;
    expect(storage.token, 'bob');
  });
}
