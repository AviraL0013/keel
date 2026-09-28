import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/features/books/data/books_repository.dart';

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
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'http://localhost:8787'),
        TestStorage(),
        client);

    final response = await api.post('/books/book-1/pause',
        decode: (value) => Map<String, dynamic>.from(value as Map));
    expect(response['status'], 'PAUSED');
  });

  test('manual recovery uses its own bodyless route and preserves automation off', () async {
    final client = MockClient((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, '/books/book-1/recover');
      expect(request.headers.containsKey('content-type'), isFalse);
      expect(request.bodyBytes, isEmpty);
      return http.Response(jsonEncode({
        'id': 'book-1', 'market': 'ETH', 'side': 'LONG', 'stance': 'DEFEND',
        'status': 'ACTIVE', 'automationEnabled': false,
        'liquidationFloor': 5, 'defenseCap': 5, 'timeLimitMs': 86400000
      }), 200);
    });
    final repository = BooksRepository(EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'http://localhost:8787'),
        TestStorage(), client));
    final book = await repository.control('book-1', 'recover');
    expect(book.status, 'ACTIVE');
    expect(book.automationEnabled, isFalse);
  });
}
