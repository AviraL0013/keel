import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/networking/api_client.dart';
import '../../auth/data/auth_repository.dart';

final enrollmentProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  ref.watch(authProvider.select((s) => (s.authenticated, s.address)));
  final api = ref.watch(apiClientProvider);
  final capability = await api.get('/connections/perpl/capabilities',
      (value) => Map<String, dynamic>.from(value as Map));
  final connections = await api.get(
      '/connections',
      (value) => (value as List)
          .whereType<Map>()
          .map((row) => Map<String, dynamic>.from(row))
          .toList());
  return {...capability, 'connections': connections};
});
