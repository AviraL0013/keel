import 'dart:convert';

import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/networking/backend_status.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _NoSession extends SessionStorage {
  @override
  Future<String?> readToken() async => null;
}

void main() {
  for (final value in [true, false, null]) {
    test('backend health maps demoAllowlist $value without guessing', () async {
      final client = MockClient((request) async {
        expect(request.url.path, '/health');
        return http.Response(
            jsonEncode({
              'ok': true,
              'environment': 'mainnet',
              if (value != null) 'demoAllowlist': value,
            }),
            200);
      });
      final container = ProviderContainer(overrides: [
        apiClientProvider.overrideWithValue(EyelerApiClient(
            const EyelerConfig(apiBaseUrl: 'https://example.invalid'),
            _NoSession(),
            client))
      ]);
      addTearDown(() {
        container.dispose();
        client.close();
      });
      final status = await container.read(backendStatusProvider.future);
      expect(status.environment, 'mainnet');
      expect(status.demoAllowlist, value == true);
    });
  }
}
