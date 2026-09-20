import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../domain/notification_item.dart';

class NotificationRepository {
  const NotificationRepository(this.api);
  final KeelApiClient api;
  Future<List<NotificationItem>> list() async {
    final value = await api.get('/notifications', (body) => body);
    if (value is! List) return const [];
    return value
        .map((item) =>
            NotificationItem.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList();
  }

  Future<void> markRead(String id) =>
      api.post('/notifications/$id/read', decode: (_) => true);
}

final notificationRepositoryProvider = Provider<NotificationRepository>(
    (ref) => NotificationRepository(ref.watch(apiClientProvider)));
final notificationProvider = FutureProvider.autoDispose<List<NotificationItem>>(
    (ref) => ref.watch(notificationRepositoryProvider).list());
