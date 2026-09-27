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
import 'package:keel_mobile/features/books/presentation/widgets/book_widgets.dart';
import 'package:keel_mobile/shared/models/telemetry_freshness.dart';
import 'package:keel_mobile/shared/widgets/keel_widgets.dart';

class DetailRepository extends BooksRepository {
  DetailRepository(this.dashboard, http.Client client)
      : super(KeelApiClient(const KeelConfig(apiBaseUrl: 'http://unused'),
            const SessionStorage(), client));
  final BookDashboardState dashboard;
  @override
  Future<BookDashboardState> state(String id) async => dashboard;
}

void main() {
  for (final width in [320.0, 427.0]) {
    testWidgets('consumer detail reveals technical data on demand at $width',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 1000);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final client = http.Client();
      addTearDown(client.close);
      const book = Book(
          id: 'eth',
          market: 'ETH',
          side: 'LONG',
          stance: 'DEFEND',
          status: 'ACTIVE',
          automationEnabled: false,
          liquidationFloor: 5,
          defenseCap: 5,
          timeLimitMs: 86400000);
      const point =
          TelemetryFreshnessPoint(status: 'FRESH', thresholdMs: 10000);
      const freshness = TelemetryFreshnessModel(
          market: point,
          position: point,
          funding: point,
          orderbook: point,
          thresholdsMs: {});
      const dashboard = BookDashboardState(
          book: book,
          telemetry: BookTelemetry(
              riskState: 'HOLD',
              executionState: 'NO_ACTIVE_EXECUTION',
              liquidationDistance: 6,
              reserveDeployed: 0,
              reserveAvailable: 5,
              pnl: .42,
              mark: 2700,
              bid: 2699,
              ask: 2701,
              leverage: 12,
              fundingRate: .00001,
              depthNotional: 100000,
              freshness: freshness));
      await tester.pumpWidget(ProviderScope(
          overrides: [
            booksRepositoryProvider
                .overrideWithValue(DetailRepository(dashboard, client)),
          ],
          child: MaterialApp(
              theme: KeelTheme.dark,
              home: const BookDetailScreen(book: book))));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Watching'), findsOneWidget);
      expect(find.text('Unrealized P&L'), findsOneWidget);
      expect(find.text('MARKET LIVE'), findsNothing);
      await tester.ensureVisible(find.text('More details'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('More details'));
      await tester.pumpAndSettle();
      expect(find.text('MARKET LIVE'), findsOneWidget);
      expect(find.byType(BookTechnicalMetrics), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('closed Book shows completion and no action controls',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 900);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    final client = http.Client();
    addTearDown(client.close);
    const book = Book(
        id: 'closed',
        market: 'ETH',
        side: 'LONG',
        stance: 'DEFEND',
        status: 'CLOSED',
        automationEnabled: false,
        liquidationFloor: 5,
        defenseCap: 5,
        timeLimitMs: 86400000);
    const dashboard = BookDashboardState(
        book: book,
        telemetry: BookTelemetry(
            riskState: 'HOLD',
            executionState: 'CONFIRMED',
            positionStatus: 'CLOSED',
            pnl: 0));
    await tester.pumpWidget(ProviderScope(
        overrides: [
          booksRepositoryProvider
              .overrideWithValue(DetailRepository(dashboard, client)),
        ],
        child: MaterialApp(
            theme: KeelTheme.dark, home: const BookDetailScreen(book: book))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Book closed'), findsOneWidget);
    expect(find.text('Action completed'), findsOneWidget);
    expect(find.byType(ActionButtonRow), findsNothing);
    expect(find.byType(BookMetricsCard), findsNothing);
    expect(find.textContaining('Unrealized P&L'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
