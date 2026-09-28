import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/books/data/books_repository.dart';
import 'package:eyeler_mobile/features/books/domain/book.dart';
import 'package:eyeler_mobile/features/books/presentation/screens/books_screen.dart';
import 'package:eyeler_mobile/shared/models/telemetry_freshness.dart';
import 'package:eyeler_mobile/shared/widgets/eyeler_widgets.dart';

const book = Book(
    id: 'book-642',
    market: 'BTC-PERP',
    side: 'LONG',
    stance: 'DEFEND',
    status: 'ACTIVE',
    automationEnabled: false,
    liquidationFloor: 6,
    defenseCap: 5,
    timeLimitMs: 86400000);

class StaticBooksRepository extends BooksRepository {
  StaticBooksRepository(this.value, http.Client client)
      : super(EyelerApiClient(const EyelerConfig(apiBaseUrl: 'http://unused'),
            const SessionStorage(), client));
  final BookDashboardState value;
  @override
  Future<BookDashboardState> state(String id) async => value;
}

void main() {
  for (final width in [320.0, 375.0, 427.0, 1440.0]) {
    for (final status in ['FRESH', 'STALE', 'UNKNOWN']) {
      testWidgets('consumer Book card fits $status at width $width',
          (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 1200);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        final point = TelemetryFreshnessPoint(
            status: status,
            ageMs: status == 'UNKNOWN'
                ? null
                : status == 'STALE'
                    ? 903000
                    : 400,
            thresholdMs: 10000);
        final freshness = TelemetryFreshnessModel(
            market: point,
            position: point,
            funding: point,
            orderbook: point,
            thresholdsMs: const {});
        final client = http.Client();
        addTearDown(client.close);
        await tester.pumpWidget(ProviderScope(
            overrides: [
              booksProvider.overrideWith((ref) async => [book]),
              booksRepositoryProvider.overrideWithValue(StaticBooksRepository(
                  BookDashboardState(
                      book: book,
                      telemetry: BookTelemetry(
                          pnl: .1,
                          reserveAvailable: 10,
                          riskState: status == 'FRESH' ? 'HOLD' : 'SAFE_MODE',
                          freshness: freshness,
                          freshnessMs: point.ageMs)),
                  client)),
            ],
            child:
                MaterialApp(theme: EyelerTheme.dark, home: const BooksScreen())));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 200));
        expect(tester.takeException(), isNull);
        final card = tester.getRect(find.byType(EyelerPanel).first);
        expect(find.byType(TelemetryFreshness), findsNothing);
        final pill = tester.getRect(find.byType(StatusPill).first);
        expect(pill.left, greaterThanOrEqualTo(card.left));
        expect(pill.right, lessThanOrEqualTo(card.right));
        expect(pill.bottom, lessThanOrEqualTo(card.bottom));
        expect(find.text(status == 'FRESH' ? 'Watching' : 'Needs attention'),
            findsOneWidget);
        expect(find.textContaining('903000'), findsNothing);
        await tester.pumpWidget(const SizedBox.shrink());
      });
    }
  }
}
