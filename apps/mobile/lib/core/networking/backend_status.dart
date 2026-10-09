import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'api_client.dart';

enum BackendState { live, offline, reconnecting }

class BackendStatus {
  const BackendStatus(this.state,
      {this.environment, this.demoAllowlist = false});
  final BackendState state;
  final String? environment;
  final bool demoAllowlist;
}

final backendStatusProvider =
    FutureProvider.autoDispose<BackendStatus>((ref) async {
  try {
    final value = await ref.watch(apiClientProvider).health();
    return BackendStatus(BackendState.live,
        environment: value['environment'] as String?,
        demoAllowlist: value['demoAllowlist'] == true);
  } catch (_) {
    return const BackendStatus(BackendState.offline);
  }
});
