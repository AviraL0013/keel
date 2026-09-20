import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../data/books_repository.dart';
import '../../domain/book.dart';
class BookActionController extends StateNotifier<AsyncValue<Book?>> {
  BookActionController(this.repository): super(const AsyncData(null));
  final BooksRepository repository;
  Future<void> run(String bookId, String action) async { state = const AsyncLoading(); try { Book? book; if (action == 'defend' || action == 'reduce') { await repository.action(bookId, action.toUpperCase()); } else if (action == 'close') { await repository.close(bookId); } else { book = await repository.control(bookId, action); } state = AsyncData(book); } catch (error, stack) { state = AsyncError(error, stack); } }
}
final bookActionProvider = StateNotifierProvider.autoDispose<BookActionController, AsyncValue<Book?>>((ref) => BookActionController(ref.watch(booksRepositoryProvider)));
