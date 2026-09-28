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
import 'package:eyeler_mobile/features/books/presentation/widgets/book_summary.dart';
import 'package:eyeler_mobile/shared/models/telemetry_freshness.dart';

Book book(String id, String market, String status) => Book(
    id: id,
    market: market,
    side: 'LONG',
    stance: 'DEFEND',
    status: status,
    automationEnabled: false,
    liquidationFloor: 5,
    defenseCap: 5,
    timeLimitMs: 86400000);

const fresh = TelemetryFreshnessModel(
    market: TelemetryFreshnessPoint(status: 'FRESH', thresholdMs: 10000),
    position: TelemetryFreshnessPoint(status: 'FRESH', thresholdMs: 10000),
    funding: TelemetryFreshnessPoint(status: 'FRESH', thresholdMs: 10000),
    orderbook: TelemetryFreshnessPoint(status: 'FRESH', thresholdMs: 10000),
    thresholdsMs: {});

class SummaryRepository extends BooksRepository {
  SummaryRepository(http.Client client)
      : super(EyelerApiClient(const EyelerConfig(apiBaseUrl: 'http://unused'),
            const SessionStorage(), client));
  final states = <String, BookDashboardState>{};
  @override
  Future<BookDashboardState> state(String id) async => states[id]!;
}

void main() {
  test('plain labels preserve execution and risk priority', () {
    final active = book('a', 'BTC', 'ACTIVE');
    expect(
        BookSummary.from(
                active, const BookTelemetry(freshness: fresh, riskState: 'HOLD'))
            .label,
        'Watching');
    expect(
        BookSummary.from(
                active,
                const BookTelemetry(
                    freshness: fresh,
                    riskState: 'HOLD',
                    executionState: 'UNKNOWN'))
            .label,
        'Checking with Perpl');
    expect(
        BookSummary.from(
                active,
                const BookTelemetry(
                    freshness: fresh,
                    riskState: 'HOLD',
                    executionState: 'FAILED'))
            .label,
        'Action not completed');
    expect(
        BookSummary.from(book('s', 'BTC', 'SAFE_MODE'),
                const BookTelemetry(freshness: fresh, riskState: 'SAFE_MODE'))
            .label,
        'Needs attention');
    expect(
        BookSummary.from(
                book('c', 'ETH', 'CLOSED'),
                const BookTelemetry(
                    freshness: fresh,
                    riskState: 'HOLD',
                    executionState: 'CONFIRMED'))
            .label,
        'Book closed');
    expect(
        BookSummary.from(
                book('c', 'ETH', 'CLOSED'),
                const BookTelemetry(executionState: 'FAILED'))
            .label,
        'Book closed');
  });

  testWidgets('Current, History, and one Filter control keep Books distinct',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 2200);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    final client = http.Client();
    addTearDown(client.close);
    final repository = SummaryRepository(client);
    var books = [
      book('active', 'BTC', 'ACTIVE'),
      book('safe', 'ETH', 'SAFE_MODE'),
      book('paused', 'SOL', 'PAUSED'),
      book('closed', 'XRP', 'CLOSED'),
    ];
    for (final item in books) {
      repository.states[item.id] = BookDashboardState(
          book: item,
          telemetry: BookTelemetry(
              pnl: item.status == 'CLOSED' ? 0 : 1,
              freshness: fresh,
              riskState: item.status == 'SAFE_MODE' ? 'SAFE_MODE' : 'HOLD',
              executionState:
                  item.status == 'CLOSED' ? 'CONFIRMED' : 'NO_ACTIVE_EXECUTION',
              positionStatus: item.status == 'CLOSED' ? 'CLOSED' : 'OPEN'));
    }
    await tester.pumpWidget(ProviderScope(overrides: [
      booksProvider.overrideWith((ref) async => books),
      booksRepositoryProvider.overrideWithValue(repository),
    ], child: MaterialApp(theme: EyelerTheme.dark, home: const BooksScreen())));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const ValueKey('book-card-safe')), findsOneWidget);
    expect(find.byKey(const ValueKey('book-card-active')), findsOneWidget);
    expect(
        tester.getTopLeft(find.byKey(const ValueKey('book-card-safe'))).dy,
        lessThan(tester
            .getTopLeft(find.byKey(const ValueKey('book-card-active')))
            .dy));
    expect(find.byKey(const ValueKey('book-card-closed')), findsNothing);
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('History'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const ValueKey('book-card-closed')), findsOneWidget);
    expect(find.byKey(const ValueKey('book-card-active')), findsNothing);
    expect(find.text('Book closed'), findsOneWidget);
    expect(find.textContaining('Unrealized P&L'), findsNothing);

    await tester.tap(find.text('Filter'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ETH').last);
    await tester.tap(find.text('SHOW BOOKS'));
    await tester.pumpAndSettle();
    expect(find.text('NO MATCHING BOOKS'), findsOneWidget);

    await tester.tap(find.text('Current'));
    await tester.pump();
    expect(find.byKey(const ValueKey('book-card-safe')), findsOneWidget);
    expect(find.byKey(const ValueKey('book-card-active')), findsNothing);
    expect(tester.takeException(), isNull);

    books = [
      book('active', 'BTC', 'CLOSED'),
      ...books.skip(1),
    ];
    repository.states['active'] = BookDashboardState(
        book: books.first,
        telemetry: const BookTelemetry(
            freshness: fresh,
            riskState: 'HOLD',
            executionState: 'CONFIRMED',
            positionStatus: 'CLOSED'));
    await tester.pump(const Duration(seconds: 15));
    await tester.pump();
    expect(find.text('2 current · 2 in history'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
