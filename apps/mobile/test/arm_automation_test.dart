import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:keel_mobile/core/config/environment.dart';
import 'package:keel_mobile/core/errors/keel_exception.dart';
import 'package:keel_mobile/core/networking/api_client.dart';
import 'package:keel_mobile/core/storage/session_storage.dart';
import 'package:keel_mobile/core/theme/app_theme.dart';
import 'package:keel_mobile/features/books/data/books_repository.dart';
import 'package:keel_mobile/features/books/domain/book.dart';
import 'package:keel_mobile/features/books/presentation/screens/book_detail_screen.dart';

const testBook = Book(
    id: 'eth', market: 'ETH', side: 'LONG', stance: 'DEFEND', status: 'ACTIVE',
    automationEnabled: false, liquidationFloor: 5, defenseCap: 5, timeLimitMs: 86400000);

class TestSessionStorage extends SessionStorage {
  const TestSessionStorage();
  @override
  Future<String?> readToken() async => null;
}

class ArmRepository extends BooksRepository {
  ArmRepository(this.rejectArm, this.book, http.Client client)
      : super(KeelApiClient(const KeelConfig(apiBaseUrl: 'http://unused'),
            const SessionStorage(), client));
  final bool rejectArm;
  final Book book;
  final calls = <String>[];
  @override
  Future<BookDashboardState> state(String id) async => BookDashboardState(
      book: book,
      telemetry: const BookTelemetry(riskState: 'HOLD', executionState: 'NO_ACTIVE_EXECUTION',
          liquidationDistance: 6, reserveAvailable: 10, mark: 100));
  @override
  Future<Book> control(String id, String action) async {
    calls.add(action);
    if (rejectArm) throw const KeelException('KILL_SWITCH_ENGAGED', statusCode: 409);
    return testBook;
  }
  @override
  Future<Book> armWithStance(String id, String stance) async {
    calls.add('patch:$stance');
    return testBook;
  }
}

void main() {
  test('stance path patches automation and stance without submitting an action', () async {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      return http.Response(jsonEncode({
        'id': 'eth', 'market': 'ETH', 'side': 'LONG', 'stance': 'DEFEND',
        'status': 'ACTIVE', 'automationEnabled': true,
        'liquidationFloor': 5, 'defenseCap': 5, 'timeLimitMs': 86400000,
      }), 200);
    });
    addTearDown(client.close);
    final repository = BooksRepository(KeelApiClient(
        const KeelConfig(apiBaseUrl: 'http://unused'),
        const TestSessionStorage(), client));
    await repository.armWithStance('eth', 'DEFEND');
    expect(requests, hasLength(1));
    expect(requests.single.method, 'PATCH');
    expect(requests.single.url.path, '/books/eth');
    expect(jsonDecode(requests.single.body),
        {'automationEnabled': true, 'stance': 'DEFEND'});
  });

  Future<ArmRepository> showBook(WidgetTester tester,
      {bool rejectArm = false, Book book = testBook}) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 1100);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    final client = http.Client();
    addTearDown(client.close);
    final repository = ArmRepository(rejectArm, book, client);
    await tester.pumpWidget(ProviderScope(
      overrides: [booksRepositoryProvider.overrideWithValue(repository)],
      child: MaterialApp(theme: KeelTheme.dark,
          home: BookDetailScreen(book: book)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    if (book.status != 'SAFE_MODE') {
      await tester.ensureVisible(find.text('ARM AUTOMATION'));
    }
    await tester.pumpAndSettle();
    return repository;
  }

  testWidgets('arming shows cap, reserve, reduce-only authority and pause before consent', (tester) async {
    final repository = await showBook(tester);
    await tester.tap(find.text('ARM AUTOMATION'));
    await tester.pumpAndSettle();
    expect(find.text('Arm automation?'), findsOneWidget);
    expect(find.textContaining('5.00 AUSD'), findsOneWidget);
    expect(find.textContaining('10.00 AUSD reserve'), findsOneWidget);
    expect(find.textContaining('reduce-only REDUCE and EXIT'), findsOneWidget);
    expect(find.textContaining('Use PAUSE'), findsOneWidget);
    await tester.tap(find.text('CANCEL'));
    await tester.pumpAndSettle();
    expect(repository.calls, isEmpty);
  });

  testWidgets('consent sends one arm request', (tester) async {
    final repository = await showBook(tester);
    await tester.tap(find.text('ARM AUTOMATION'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ARM AUTOMATION').last);
    await tester.pumpAndSettle();
    expect(repository.calls, ['arm']);
  });

  testWidgets('kill switch 409 offers stance picker then patches stance and automation', (tester) async {
    final repository = await showBook(tester, rejectArm: true);
    await tester.tap(find.text('ARM AUTOMATION'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ARM AUTOMATION').last);
    await tester.pumpAndSettle();
    expect(find.text('Choose a stance'), findsOneWidget);
    expect(find.text('Never rescue. Exit when a limit breaks.'), findsOneWidget);
    await tester.tap(find.descendant(
        of: find.byType(SimpleDialog), matching: find.text('DEFEND')));
    await tester.pumpAndSettle();
    expect(repository.calls, ['arm', 'patch:DEFEND']);
  });

  for (final entry in {
    'DATA_UNAVAILABLE': 'Waiting for live data — automation resumes automatically.',
    'VENUE_UNAVAILABLE': 'Waiting for live data — automation resumes automatically.',
    'UNRESOLVED_ACTION': 'Checking an action with Perpl — review needed.',
    'RUNTIME_FAILURE': 'Automation stopped — review needed.',
  }.entries) {
    testWidgets('explains ${entry.key} without an arm button', (tester) async {
      final safeBook = Book(
          id: 'eth', market: 'ETH', side: 'LONG', stance: 'DEFEND',
          status: 'SAFE_MODE', safeModeReason: entry.key,
          automationEnabled: entry.key == 'DATA_UNAVAILABLE' ||
              entry.key == 'VENUE_UNAVAILABLE',
          liquidationFloor: 5, defenseCap: 5, timeLimitMs: 86400000);
      await showBook(tester, book: safeBook);
      await tester.ensureVisible(find.text(entry.value));
      await tester.pumpAndSettle();
      expect(find.text(entry.value), findsOneWidget);
      expect(find.text('ARM AUTOMATION'), findsNothing);
      if (safeBook.automationEnabled) {
        expect(find.text('RESTORE MANUAL ACTIONS'), findsNothing);
      }
    });
  }
}
