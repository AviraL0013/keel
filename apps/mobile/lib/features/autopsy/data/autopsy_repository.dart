import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../domain/autopsy_event.dart';

class AutopsyRepository {
  const AutopsyRepository(this.api);
  final KeelApiClient api;
  Future<List<AutopsyEvent>> list(String bookId) async {
    final value = await api.get('/books/$bookId/autopsy', (body) => body);
    if (value is! List) return const [];
    return value
        .map((item) =>
            AutopsyEvent.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList();
  }
}

final autopsyRepositoryProvider = Provider<AutopsyRepository>(
    (ref) => AutopsyRepository(ref.watch(apiClientProvider)));
final autopsyProvider = FutureProvider.family
    .autoDispose<List<AutopsyEvent>, String>(
        (ref, id) => ref.watch(autopsyRepositoryProvider).list(id));
