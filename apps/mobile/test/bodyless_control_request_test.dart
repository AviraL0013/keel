import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:keel_mobile/core/config/environment.dart';
import 'package:keel_mobile/core/networking/api_client.dart';
import 'package:keel_mobile/core/storage/session_storage.dart';

class TestStorage extends SessionStorage {
  @override
  Future<String?> readToken() async => 'test-token';
}

void main() {
  test('bodyless Book pause omits JSON content type and request body', () async {
    final client = MockClient((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, '/books/book-1/pause');
      expect(request.headers['authorization'], 'Bearer test-token');
      expect(request.headers.containsKey('content-type'), isFalse);
      expect(request.bodyBytes, isEmpty);
      return http.Response(jsonEncode({'status': 'PAUSED'}), 200);
    });
    final api = KeelApiClient(
        const KeelConfig(apiBaseUrl: 'http://localhost:8787'),
        TestStorage(),
        client);

    final response = await api.post('/books/book-1/pause',
        decode: (value) => Map<String, dynamic>.from(value as Map));
    expect(response['status'], 'PAUSED');
  });
}
