import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/networking/backend_status.dart';
import 'package:eyeler_mobile/core/routing/app_router.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/analytics/analytics_contract.dart';
import 'package:eyeler_mobile/features/analytics/analytics_repository.dart';
import 'package:eyeler_mobile/features/analytics/public_analytics_client.dart';
import 'package:eyeler_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _PrivateStorage extends SessionStorage {
  int reads = 0;
  @override
  Future<String?> readToken() async {
    reads++;
    throw StateError('Public analytics must not access session tokens');
  }
}

void main() {
  test(
      'public analytics client sends no credentials and cannot address private routes',
      () async {
    var sends = 0;
    final client = MockClient((request) async {
      sends++;
      expect(request.method, 'GET');
      expect(request.url.toString(),
          'https://fixture.invalid/analytics/v1/markets');
      expect(request.headers.containsKey('authorization'), isFalse);
      expect(request.headers.containsKey('cookie'), isFalse);
      return http.Response('{"data":{"items":[]}}', 200);
    });
    addTearDown(client.close);
    final api = PublicAnalyticsClient('https://fixture.invalid', client);
    expect(await api.get('/analytics/v1/markets'), isA<Map>());
    for (final path in [
      '/books',
      '/auth/session',
      '/analytics/v1/../books',
      'https://other.invalid/analytics/v1/markets'
    ]) {
      await expectLater(api.get(path), throwsFormatException);
    }
    expect(sends, 1);
  });

  test('a public 401 does not clear or retry a private session', () async {
    var sends = 0;
    final client = MockClient((_) async {
      sends++;
      return http.Response('{"error":"UNAUTHENTICATED"}', 401);
    });
    addTearDown(client.close);
    await expectLater(
        PublicAnalyticsClient('https://fixture.invalid', client)
            .get('/analytics/v1/markets'),
        throwsStateError);
    expect(sends, 1);
  });

  test('parses partial coverage without treating its totals as all-time', () {
    final response = V1Envelope.fromJson({
      'asOf': '2026-10-08T00:00:00Z',
      'block': 100,
      'source': 'derived',
      'stale': true,
      'coverage': {
        'from': '2026-10-01T00:00:00Z',
        'through': '2026-10-08T00:00:00Z',
        'completeHistory': false,
        'label': 'Since 2026-10-01',
      },
      'data': <String, dynamic>{},
    }, (raw) => raw);
    expect(response.coverage?.completeHistory, isFalse);
    expect(response.coverage?.label, 'Since 2026-10-01');
  });

  for (final width in [320.0, 360.0]) {
    testWidgets('public deep link avoids private storage at ${width.toInt()}dp',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 860);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final storage = _PrivateStorage();
      await tester.pumpWidget(ProviderScope(overrides: [
        sessionStorageProvider.overrideWithValue(storage),
        analyticsRepositoryProvider
            .overrideWithValue(FixtureAnalyticsRepository.sample()),
      ], child: const EyelerApp(initialRoute: '/analytics')));
      await tester.pumpAndSettle();
      expect(storage.reads, 0);
      expect(find.text('Protocol overview'), findsOneWidget);
      expect(find.text('Monad mainnet'), findsOneWidget);
      expect(find.text('SIGN IN WITH PASSKEY'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('private entry remains behind wallet authentication',
      (tester) async {
    await tester.pumpWidget(ProviderScope(
        overrides: [
          backendStatusProvider.overrideWith((ref) async =>
              const BackendStatus(BackendState.live, environment: 'testnet')),
        ],
        child: MaterialApp(
            theme: EyelerTheme.dark,
            home: const EyelerRouter(authenticated: false))));
    await tester.pump();
    expect(find.text('SIGN IN WITH PASSKEY'), findsOneWidget);
    expect(find.text('Your Books'), findsNothing);
    expect(find.text('Browse public analytics'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
