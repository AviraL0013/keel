import '../../auth/data/auth_repository.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';

class SettingsRepository {
  const SettingsRepository(this.api);
  final EyelerApiClient api;
  Future<Map<String, dynamic>> killSwitch() => api.post('/controls/kill-switch',
      decode: (value) => Map<String, dynamic>.from(value as Map));
  Future<void> scenario(String value) => api.post('/dev/test-venue/scenario',
      body: {'scenario': value}, decode: (_) => true);
}

final settingsRepositoryProvider = Provider<SettingsRepository>((ref) {
  ref.watch(
      authProvider.select((state) => (state.authenticated, state.address)));
  return SettingsRepository(ref.watch(apiClientProvider));
});
