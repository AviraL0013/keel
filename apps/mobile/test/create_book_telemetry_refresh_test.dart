import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:keel_mobile/core/config/environment.dart';
import 'package:keel_mobile/core/networking/api_client.dart';
import 'package:keel_mobile/core/storage/session_storage.dart';
import 'package:keel_mobile/core/theme/app_theme.dart';
import 'package:keel_mobile/features/books/presentation/screens/create_book_screen.dart';
import 'package:keel_mobile/features/capital/data/capital_repository.dart';
import 'package:keel_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:keel_mobile/features/positions/data/positions_repository.dart';
import 'package:keel_mobile/features/positions/domain/position.dart';
import 'package:keel_mobile/shared/models/telemetry_freshness.dart';

const point = TelemetryFreshnessPoint(status: 'STALE', ageMs: 14329, thresholdMs: 10000);

Position position(bool ready, double mark) => Position(
      marketId: 16,
      accountId: 642,
      market: 'BTC',
      positionId: 77,
      side: 'LONG',
      size: 0.0001,
      entryPrice: 80599.3,
      markPrice: mark,
      liquidationPrice: 78449.99,
      leverage: 15,
      margin: 0.54,
      status: 'OPEN',
      bookCreation: BookCreationReadiness(
        allowed: ready,
        code: ready ? 'READY' : 'MARKET_TELEMETRY_STALE',
        reason: ready ? 'Live telemetry is ready.' : 'Live market telemetry is stale by 14329ms.',
        market: point,
        position: point,
      ),
    );

class SequencedPositionsRepository extends PositionsRepository {
  SequencedPositionsRepository(http.Client client, this.responses)
      : super(KeelApiClient(const KeelConfig(apiBaseUrl: 'http://unused'), const SessionStorage(), client));

  final List<Object> responses;
  int reads = 0;

  @override
  Future<List<Position>> list() async {
    final response = responses[reads < responses.length ? reads : responses.length - 1];
    reads += 1;
    if (response is Exception) throw response;
    return [response as Position];
  }
}

void main() {
  testWidgets('Configure Book refreshes selected position in place and fails closed', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 1200);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    final client = http.Client();
    final stale = position(false, 83890.6);
    final fresh = position(true, 83901.2);
    final repository = SequencedPositionsRepository(client, [stale, fresh, stale, Exception('offline')]);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        positionsRepositoryProvider.overrideWithValue(repository),
        capitalProvider.overrideWith((ref) async => CapitalSnapshot.fromJson({
              'status': 'VALID',
              'walletAusd': '9900',
              'perplAvailable': '99.457410',
              'perplLocked': '0',
            })),
      ],
      child: MaterialApp(theme: KeelTheme.dark, home: CreateBookScreen(position: stale)),
    ));
    await tester.pump();
    final screen = tester.element(find.byType(CreateBookScreen));
    expect(find.text('Live market telemetry is stale by 14329ms.'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Review Book')).onPressed, isNull);

    await tester.enterText(find.byType(TextField).first, '6');
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.textContaining('mark 83901.2'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Review Book')).onPressed, isNotNull);
    expect(tester.widget<TextField>(find.byType(TextField).first).controller?.text, '6');
    expect(identical(screen, tester.element(find.byType(CreateBookScreen))), isTrue);

    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Review Book')).onPressed, isNull);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('Live position and market telemetry could not be refreshed. Retry shortly.'), findsOneWidget);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Review Book')).onPressed, isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });
}
