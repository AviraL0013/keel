import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../domain/capital_snapshot.dart';
class CapitalRepository { const CapitalRepository(this.api); final KeelApiClient api; Future<CapitalSnapshot> get() => api.get('/capital', (value) => CapitalSnapshot.fromJson(Map<String, dynamic>.from(value as Map))); }
final capitalRepositoryProvider = Provider<CapitalRepository>((ref) => CapitalRepository(ref.watch(apiClientProvider)));
final capitalProvider = FutureProvider.autoDispose<CapitalSnapshot>((ref) => ref.watch(capitalRepositoryProvider).get());
