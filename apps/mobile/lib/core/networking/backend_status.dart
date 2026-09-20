import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'api_client.dart';

enum BackendState { live, offline, reconnecting }

class BackendStatus {
  const BackendStatus(this.state, {this.environment});
  final BackendState state;
  final String? environment;
}

final backendStatusProvider =
    FutureProvider.autoDispose<BackendStatus>((ref) async {
  try {
    final value = await ref.watch(apiClientProvider).health();
    return BackendStatus(BackendState.live,
        environment: value['environment'] as String?);
  } catch (_) {
    return const BackendStatus(BackendState.offline);
  }
});
