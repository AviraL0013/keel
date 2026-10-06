import '../../auth/data/auth_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../domain/capital_snapshot.dart';

class CapitalRepository {
  const CapitalRepository(this.api);
  final EyelerApiClient api;
  Future<CapitalSnapshot> get() => api.get(
      '/capital',
      (value) =>
          CapitalSnapshot.fromJson(Map<String, dynamic>.from(value as Map)));
  Future<AgoraActivity> getAgoraActivity({String? cursor}) => api.get(
      cursor == null
          ? '/capital/agora-activity'
          : '/capital/agora-activity?cursor=${Uri.encodeQueryComponent(cursor)}',
      (value) =>
          AgoraActivity.fromJson(Map<String, dynamic>.from(value as Map)));
}

final capitalRepositoryProvider = Provider<CapitalRepository>((ref) {
  ref.watch(
      authProvider.select((state) => (state.authenticated, state.address)));
  return CapitalRepository(ref.watch(apiClientProvider));
});
final capitalProvider = FutureProvider.autoDispose<CapitalSnapshot>(
    (ref) => ref.watch(capitalRepositoryProvider).get());
final agoraActivityProvider = FutureProvider.autoDispose<AgoraActivity>(
    (ref) => ref.watch(capitalRepositoryProvider).getAgoraActivity());
