import 'dart:async';
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
import 'package:keel_mobile/features/books/presentation/screens/books_screen.dart';
import 'package:keel_mobile/shared/models/telemetry_freshness.dart';

const book = Book(id: '642', market: 'BTC', side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', automationEnabled: false, liquidationFloor: 6, defenseCap: 5, timeLimitMs: 86400000);

class ControlledRepository extends BooksRepository {
  ControlledRepository(http.Client client) : super(KeelApiClient(const KeelConfig(apiBaseUrl: 'http://unused'), const SessionStorage(), client));
  final lists = <Completer<List<Book>>>[];
  final snapshots = <Completer<BookDashboardState>>[];
  @override
  Future<List<Book>> list() { final request = Completer<List<Book>>(); lists.add(request); return request.future; }
  @override
  Future<BookDashboardState> state(String id) { final request = Completer<BookDashboardState>(); snapshots.add(request); return request.future; }
}

BookDashboardState snapshot(double pnl, String status) {
  final point = TelemetryFreshnessPoint(status: status, ageMs: status == 'STALE' ? 32485000 : 100, thresholdMs: 10000);
  return BookDashboardState(book: book, telemetry: BookTelemetry(pnl: pnl, mark: 80000 + pnl, reserveAvailable: 10, riskState: status == 'FRESH' ? 'HOLD' : 'SAFE_MODE', riskReason: 'Backend explanation', executionState: 'NO_ACTIVE_EXECUTION', freshness: TelemetryFreshnessModel(market: point, position: point, funding: point, orderbook: point, thresholdsMs: const {})));
}

void main() {
  testWidgets('initial loading only; polling and manual resync preserve mounted card, data, and scroll position', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 1200);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    final client = http.Client();
    final repository = ControlledRepository(client);
    await tester.pumpWidget(ProviderScope(overrides: [booksRepositoryProvider.overrideWithValue(repository)], child: MaterialApp(theme: KeelTheme.dark, home: const BooksScreen())));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    repository.lists.single.complete([book]);
    await tester.pump();
    repository.snapshots.single.complete(snapshot(1, 'FRESH'));
    await tester.pump();
    final card = tester.element(find.byType(Card).first);
    final screen = tester.element(find.byType(BooksScreen));
    final scroll = tester.state<ScrollableState>(find.byType(Scrollable).first);
    expect(find.text('MARKET LIVE'), findsOneWidget);
    expect(find.text('BOOK ACTIVE'), findsOneWidget);
    expect(find.text('AUTOMATION OFF'), findsOneWidget);
    expect(find.text('NO_ACTIVE_EXECUTION'), findsOneWidget);
    expect(find.text('Backend explanation'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
    expect(repository.snapshots.length, 2);
    expect(find.text('1.00'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    repository.snapshots.last.complete(snapshot(2, 'STALE'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('2.00'), findsOneWidget);
    expect(find.text('MARKET STALE'), findsOneWidget);
    expect(find.textContaining('32485'), findsNothing);
    expect(find.text('UPDATED'), findsOneWidget);
    expect(identical(card, tester.element(find.byType(Card).first)), isTrue);
    expect(identical(screen, tester.element(find.byType(BooksScreen))), isTrue);
    expect(identical(scroll, tester.state<ScrollableState>(find.byType(Scrollable).first)), isTrue);
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('UPDATED'), findsNothing);

    await tester.tap(find.byTooltip('Resync Books'));
    await tester.pump();
    expect(find.text('2.00'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    repository.lists.last.complete([book]);
    await tester.pump();
    repository.snapshots.last.complete(snapshot(3, 'FRESH'));
    await tester.pump();
    expect(find.text('3.00'), findsOneWidget);
    expect(find.text('MARKET LIVE'), findsOneWidget);
    expect(find.text('UPDATED'), findsWidgets);
    expect(identical(card, tester.element(find.byType(Card).first)), isTrue);
    expect(tester.takeException(), isNull);

    await tester.pump(const Duration(seconds: 3));
    repository.snapshots.last.completeError(Exception('offline'));
    await tester.pump();
    expect(find.text('3.00'), findsOneWidget);
    expect(find.text('MARKET LIVE'), findsOneWidget);
    expect(identical(card, tester.element(find.byType(Card).first)), isTrue);
    await tester.pump(const Duration(seconds: 3));
    repository.snapshots.last.complete(snapshot(4, 'FRESH'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('MARKET LIVE'), findsOneWidget);
    expect(find.text('4.00'), findsOneWidget);
    expect(identical(card, tester.element(find.byType(Card).first)), isTrue);
    await tester.pumpWidget(const SizedBox.shrink());
    client.close();
  });
}


