import 'dart:convert';

import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/books/data/books_repository.dart';
import 'package:eyeler_mobile/features/books/domain/book.dart';
import 'package:eyeler_mobile/features/books/presentation/screens/create_book_screen.dart';
import 'package:eyeler_mobile/features/capital/data/capital_repository.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:eyeler_mobile/features/positions/data/positions_repository.dart';
import 'package:eyeler_mobile/features/positions/domain/position.dart';
import 'package:eyeler_mobile/shared/models/telemetry_freshness.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class TestStorage extends SessionStorage {
  @override
  Future<String?> readToken() async => 'fixture-token';
}

class TestPositionsRepository extends PositionsRepository {
  TestPositionsRepository(http.Client client)
      : super(EyelerApiClient(const EyelerConfig(apiBaseUrl: 'http://unused'),
            TestStorage(), client));

  @override
  Future<List<Position>> list() async => [selectedPosition()];
}

Position selectedPosition({String market = 'BTC'}) => Position(
      marketId: 1,
      accountId: 5448,
      market: market,
      positionId: 77,
      side: 'LONG',
      size: 0.00002,
      entryPrice: 82948.9,
      markPrice: 82953.5,
      liquidationPrice: 3317.96,
      leverage: 1,
      margin: 1.66,
      status: 'OPEN',
      bookCreation: const BookCreationReadiness(
        allowed: true,
        code: 'READY',
        reason: 'Live telemetry is ready.',
        market: TelemetryFreshnessPoint(status: 'FRESH', thresholdMs: 10000),
        position: TelemetryFreshnessPoint(status: 'FRESH', thresholdMs: 10000),
      ),
    );

BookConfiguration configuration(Duration duration) => BookConfiguration(
      liquidationFloor: 95.96,
      defenseCap: 0.01,
      reserve: 0.01,
      timeLimit: duration,
      stance: 'HARVEST',
      automation: false,
    );

Future<void> showReview(WidgetTester tester, Duration duration,
    {String market = 'BTC'}) async {
  await tester.pumpWidget(ProviderScope(
    overrides: [
      capitalProvider.overrideWith((ref) async => CapitalSnapshot.fromJson({
            'status': 'VALID',
            'walletAusd': '0',
            'perplAvailable': '0.340449',
            'perplLocked': '0',
          })),
    ],
    child: MaterialApp(
      theme: EyelerTheme.dark,
      home: BookReviewScreen(
          position: selectedPosition(market: market),
          config: configuration(duration)),
    ),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('Entering 0.25 hours reviews a fifteen-minute Book',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 1200);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    final client = http.Client();
    addTearDown(client.close);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        positionsRepositoryProvider
            .overrideWithValue(TestPositionsRepository(client)),
        capitalProvider.overrideWith((ref) async => CapitalSnapshot.fromJson({
              'status': 'VALID',
              'walletAusd': '0',
              'perplAvailable': '0.340449',
              'perplLocked': '0',
            })),
      ],
      child: MaterialApp(
          theme: EyelerTheme.dark,
          home: CreateBookScreen(position: selectedPosition())),
    ));
    await tester.pump();
    for (final input in [(0, '95.96'), (1, '0.01'), (2, '0.01'), (3, '0.25')]) {
      await tester.enterText(find.byType(TextField).at(input.$1), input.$2);
    }
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('HARVEST').last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Review Book'));
    await tester.tap(find.text('Review Book'));
    await tester.pumpAndSettle();
    expect(find.byType(BookReviewScreen), findsOneWidget);
    expect(find.textContaining(' / 15 min / HARVEST / automation off'),
        findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final example in [
    (const Duration(minutes: 15), '15 min'),
    (const Duration(hours: 1), '1h'),
    (const Duration(minutes: 75), '1h 15 min'),
  ]) {
    testWidgets('Book review displays ${example.$2} without truncation',
        (tester) async {
      await showReview(tester, example.$1);
      expect(find.textContaining(' / ${example.$2} / HARVEST / automation off'),
          findsOneWidget);
      expect(find.textContaining('BTC / LONG'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Book review blocks creation when market identity is missing',
      (tester) async {
    await showReview(tester, const Duration(minutes: 15), market: '');
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Create Book'))
            .onPressed,
        isNull);
    expect(
        find.textContaining('Market identity is unavailable'), findsOneWidget);
  });

  test('Book creation sends fifteen minutes and preserves automation off',
      () async {
    Map<String, dynamic>? payload;
    final client = MockClient((request) async {
      expect(request.url.path, '/books');
      payload = jsonDecode(request.body) as Map<String, dynamic>;
      return http.Response(
          jsonEncode({
            'id': 'book',
            'market': 'BTC',
            'side': 'LONG',
            'stance': 'HARVEST',
            'status': 'ACTIVE',
            'automationEnabled': false,
            'liquidationFloor': 95.96,
            'defenseCap': 0.01,
            'timeLimitMs': 900000,
          }),
          200);
    });
    addTearDown(client.close);
    final repository = BooksRepository(EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'http://unused'),
        TestStorage(),
        client));
    final book = await repository.create(
        selectedPosition(), configuration(const Duration(minutes: 15)));
    expect(payload?['timeLimitMs'], 900000);
    expect(payload?['market'], 'BTC');
    expect(payload?['marketId'], 1);
    expect(payload?['venueAccountId'], 5448);
    expect(payload?['venuePositionId'], 77);
    expect(payload?['automationEnabled'], false);
    expect(book.timeLimitMs, 900000);
  });
}
