import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:keel_mobile/core/config/environment.dart';
import 'package:keel_mobile/core/networking/api_client.dart';
import 'package:keel_mobile/core/storage/session_storage.dart';
import 'package:keel_mobile/features/books/data/books_repository.dart';
import 'package:keel_mobile/features/books/domain/book.dart';

class DelayedBooksRepository extends BooksRepository {
  DelayedBooksRepository(http.Client client) : super(KeelApiClient(const KeelConfig(apiBaseUrl: 'http://unused'), const SessionStorage(), client));
  final requests = <Completer<BookDashboardState>>[];
  @override
  Future<BookDashboardState> state(String id) {
    final result = Completer<BookDashboardState>();
    requests.add(result);
    return result.future;
  }
}

const book = Book(id: '1', market: 'BTC', side: 'LONG', stance: 'DEFEND', status: 'ACTIVE', automationEnabled: false, liquidationFloor: 6, defenseCap: 5, timeLimitMs: 86400000);

void main() {
  testWidgets('card and detail share polling; slow reads do not overlap; disposal stops polling', (tester) async {
    final client = http.Client();
    final repository = DelayedBooksRepository(client);
    final container = ProviderContainer(overrides: [booksRepositoryProvider.overrideWithValue(repository)]);
    final card = container.listen(bookDashboardProvider('1'), (_, __) {});
    final detail = container.listen(bookDashboardProvider('1'), (_, __) {});
    await tester.pump();
    expect(repository.requests.length, 1);
    await tester.pump(const Duration(seconds: 9));
    expect(repository.requests.length, 1);
    repository.requests[0].complete(const BookDashboardState(book: book, telemetry: BookTelemetry(mark: 100)));
    await tester.pump();
    expect(container.read(bookDashboardProvider('1')).value?.telemetry.mark, 100);
    await tester.pump(const Duration(seconds: 3));
    expect(repository.requests.length, 2);
    repository.requests[1].complete(const BookDashboardState(book: book, telemetry: BookTelemetry(mark: 101)));
    await tester.pump();
    expect(container.read(bookDashboardProvider('1')).value?.telemetry.mark, 101);
    card.close();
    detail.close();
    container.dispose();
    await tester.pump(const Duration(seconds: 9));
    expect(repository.requests.length, 2);
    client.close();
  });
}
