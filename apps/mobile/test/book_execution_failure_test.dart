import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:keel_mobile/core/config/environment.dart';
import 'package:keel_mobile/core/networking/api_client.dart';
import 'package:keel_mobile/core/storage/session_storage.dart';
import 'package:keel_mobile/core/theme/app_theme.dart';
import 'package:keel_mobile/features/books/data/books_repository.dart';
import 'package:keel_mobile/features/books/domain/book.dart';
import 'package:keel_mobile/features/books/presentation/screens/book_detail_screen.dart';

const book = Book(
    id: 'eth-book',
    market: 'ETH',
    side: 'LONG',
    stance: 'DEFEND',
    status: 'ACTIVE',
    automationEnabled: false,
    liquidationFloor: 5,
    defenseCap: 5,
    timeLimitMs: 86400000);

class FailedBookRepository extends BooksRepository {
  FailedBookRepository()
      : super(KeelApiClient(const KeelConfig(apiBaseUrl: 'http://unused'),
            const SessionStorage(), http.Client()));

  @override
  Future<BookDashboardState> state(String id) async => const BookDashboardState(
      book: book,
      telemetry: BookTelemetry(
          liquidationDistance: 4.43,
          reserveDeployed: 0,
          reserveAvailable: 5,
          mark: 2714.69,
          bid: 2715.81,
          ask: 2716.11,
          pnl: 0.62,
          leverage: 12,
          fundingRate: 0.00002,
          depthNotional: 2015779.80,
          riskState: 'HOLD',
          executionState: 'FAILED',
          executionReason:
              'Market telemetry became stale before submission. No Perpl order was sent.'));
}

void main() {
  testWidgets('failed execution displays backend reason', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(900, 952);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(ProviderScope(
        overrides: [
          booksRepositoryProvider.overrideWithValue(FailedBookRepository())
        ],
        child: MaterialApp(
            theme: KeelTheme.dark, home: const BookDetailScreen(book: book))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.scrollUntilVisible(
        find.text(
            'Market telemetry became stale before submission. No Perpl order was sent.'),
        300,
        scrollable: find.byType(Scrollable).first);
    expect(find.text('Action failed'), findsOneWidget);
    expect(
        find.text(
            'Market telemetry became stale before submission. No Perpl order was sent.'),
        findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
