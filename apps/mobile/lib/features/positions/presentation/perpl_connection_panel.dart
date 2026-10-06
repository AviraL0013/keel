import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../../../core/wallet/perpl_enrollment_signing.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../../auth/data/auth_repository.dart';
import '../../capital/data/capital_repository.dart';
import '../data/positions_repository.dart';

final enrollmentProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  ref.watch(
      authProvider.select((state) => (state.authenticated, state.address)));
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

class PerplConnectionPanel extends ConsumerStatefulWidget {
  const PerplConnectionPanel({super.key});
  @override
  ConsumerState<PerplConnectionPanel> createState() =>
      _PerplConnectionPanelState();
}

class _PerplConnectionPanelState extends ConsumerState<PerplConnectionPanel> {
  bool busy = false;
  String? message;
  @override
  Widget build(BuildContext context) => EyelerPanel(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: Text('Your Perpl connection')),
          IconButton(
              tooltip: 'Refresh Perpl connection',
              onPressed: busy ? null : _refresh,
              icon: const Icon(Icons.refresh))
        ]),
        ref.watch(enrollmentProvider).when(
            loading: () => const LinearProgressIndicator(),
            error: (_, __) =>
                const Text('Connection details unavailable. Refresh to retry.'),
            data: (value) {
              if (value['status'] != 'AVAILABLE') {
                return Text(value['reason'] == 'OPERATOR_ACCOUNT_MODE'
                    ? 'This deployment uses a restricted operator account. Individual enrollment is not enabled.'
                    : 'Individual Perpl enrollment is not configured for this environment.');
              }
              final rows =
                  (value['connections'] as List).cast<Map<String, dynamic>>();
              final current = rows
                  .where((r) =>
                      r['environment'] == value['environment'] &&
                      ['ACTIVE', 'PENDING', 'ENROLLING', 'ERROR']
                          .contains(r['status']))
                  .firstOrNull;
              return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                        '${value['environment'].toString().toUpperCase()} · Builder ${value['builderId']} · Trade-only access'),
                    const Text(
                        'Your passkey wallet connects to its own Perpl account. Existing external-wallet funds remain separate.'),
                    if (current != null)
                      Text('Connection: ${current['status']}'),
                    if (current?['lastError'] != null)
                      const Text(
                          'Enrollment outcome needs review. Check API keys on Perpl before trying again.'),
                    if (current == null)
                      FilledButton(
                          onPressed: busy ? null : () => _enroll(value),
                          child: const Text('CONNECT MY PERPL ACCOUNT')),
                    if (current != null && current['status'] != 'ENROLLING')
                      TextButton(
                          onPressed: busy
                              ? null
                              : () => _disconnect(current['id'] as String),
                          child: const Text('DISCONNECT ACCESS')),
                    if (current?['status'] == 'ACTIVE')
                      const Text(
                          'Refresh Positions to verify the account. If the wallet is inactive, activate it on Perpl first.'),
                  ]);
            }),
        if (busy) const LinearProgressIndicator(),
        if (message != null) Text(message!),
      ]));

  void _refresh() {
    ref.invalidate(enrollmentProvider);
    ref.invalidate(perplConnectionProvider);
    ref.invalidate(positionsProvider);
    ref.invalidate(capitalProvider);
  }

  Future<void> _enroll(Map<String, dynamic> capability) async {
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final address = ref.read(authProvider).address;
      if (address == null) throw StateError('Sign in again.');
      final wallet = ref.read(walletConnectorProvider);
      final connection = await wallet.connect();
      if (connection.address.toLowerCase() != address.toLowerCase() ||
          connection.chainId != capability['chainId']) {
        throw StateError('The wallet or network differs from this session.');
      }
      final api = ref.read(apiClientProvider);
      final pending = await api.post('/connections/perpl/enrollment',
          decode: (v) => Map<String, dynamic>.from(v as Map));
      final typed = Map<String, Object?>.from(pending['typedData'] as Map);
      perplEnrollmentPreimage(typed,
          address: address,
          chainId: connection.chainId,
          origin: capability['origin'] as String,
          now: DateTime.now());
      if (!mounted) return;
      final terms = typed['message'] as Map;
      final confirmed = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
                  title: const Text('Authorize Eyeler on Perpl?'),
                  content: SingleChildScrollView(
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                        Text(
                            '${capability['environment'].toString().toUpperCase()} · Chain ${connection.chainId}'),
                        SelectableText(address),
                        const SizedBox(height: 12),
                        Text(terms['statement'] as String),
                        const Text(
                            'Read and trade permission. No withdrawals. Builder fee ceiling: 0%.'),
                        Text(
                            'Expires: ${DateTime.fromMillisecondsSinceEpoch(int.parse(terms['expiresAt'] as String)).toLocal()}'),
                        const Text(
                            'API credentials are encrypted on the Eyeler server. Disconnecting blocks further Eyeler use; revoke the key on Perpl to remove its venue permission.'),
                      ])),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(context, false),
                        child: const Text('CANCEL')),
                    FilledButton(
                        onPressed: () => Navigator.pop(context, true),
                        child: const Text('AUTHORIZE'))
                  ]));
      if (confirmed != true) {
        await api.post(
            '/connections/perpl/${pending['connectionId']}/disconnect',
            decode: (_) => true);
        return;
      }
      final signature = await wallet.signTypedData(address, typed);
      await api.post(
          '/connections/perpl/enrollment/${pending['connectionId']}/complete',
          body: {'signature': signature},
          decode: (_) => true);
      if (mounted) {
        setState(() => message =
            'Perpl key connected. Refresh Positions to verify the account.');
      }
    } catch (_) {
      if (mounted) {
        setState(() => message =
            'Connection not completed. Refresh status before retrying. No trade was placed.');
      }
    } finally {
      if (mounted) {
        setState(() => busy = false);
        _refresh();
      }
    }
  }

  Future<void> _disconnect(String id) async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
                title: const Text('Disconnect Perpl?'),
                content: const Text(
                    'Eyeler will lose access to this account. Review unresolved actions first. Revoke the API key on Perpl as well.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('CANCEL')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('DISCONNECT'))
                ]));
    if (confirmed != true || !mounted) return;
    setState(() => busy = true);
    try {
      await ref
          .read(apiClientProvider)
          .post('/connections/perpl/$id/disconnect', decode: (_) => true);
    } catch (_) {
      if (mounted) {
        setState(() => message =
            'Disconnect failed. Resolve pending executions and refresh status.');
      }
    } finally {
      if (mounted) {
        setState(() => busy = false);
        _refresh();
      }
    }
  }
}
