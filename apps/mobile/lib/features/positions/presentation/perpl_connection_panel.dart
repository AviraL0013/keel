import 'package:http/http.dart' as http;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/errors/eyeler_exception.dart';
import '../../../core/networking/api_client.dart';
import '../../../core/wallet/perpl_enrollment_signing.dart';
import '../../../core/wallet/wallet_types.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../../activation/perpl_activation.dart';
import '../../auth/data/auth_repository.dart';
import '../../capital/data/capital_repository.dart';
import '../data/positions_repository.dart';
import '../data/perpl_connection_repository.dart';
export '../data/perpl_connection_repository.dart' show enrollmentProvider;

/// Reads the account ID and owner from Monad before requesting signed terms.
final perplEnrollmentAccountProvider =
    Provider<Future<int?> Function(String)>((_) => (address) async {
          final client = http.Client();
          try {
            return (await PerplActivationGateway(client).load(address))
                .state
                .accountId;
          } finally {
            client.close();
          }
        });

String _enrollmentFailure(Object error) {
  if (error is EyelerException) {
    if (RegExp(r'^[A-Z][A-Z0-9_]+$').hasMatch(error.message)) {
      return error.message;
    }
    return error.statusCode == null
        ? 'REQUEST_FAILED'
        : 'HTTP_${error.statusCode}';
  }
  if (error is WalletException) return error.message;
  return 'UNEXPECTED_FAILURE';
}

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
                          'Access is connected. Continue setup in Home to verify the account, collateral and order forwarding.'),
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
    String stage = 'account verification';
    String? pendingId;
    var signatureSubmitted = false;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final address = ref.read(authProvider).address;
      if (address == null) throw StateError('Sign in again.');
      final chainId = capability['chainId'];
      final origin = capability['origin'];
      if (chainId is! int ||
          origin is! String ||
          capability['scope'] != 'read,trade' ||
          capability['withdrawals'] != false ||
          capability['maxBuilderFeePer100K'] != 0 ||
          (capability['environment'] == 'mainnet' &&
              (chainId != 143 ||
                  origin != 'https://app.eyeler.xyz' ||
                  capability['builderId'] != 25))) {
        throw const WalletException('Perpl trade-only capability mismatch.');
      }
      final accountId = capability['environment'] == 'mainnet'
          ? await ref.read(perplEnrollmentAccountProvider)(address)
          : null;
      if (capability['environment'] == 'mainnet' &&
          (accountId == null || accountId <= 0)) {
        throw const WalletException('Owner-bound Perpl account unavailable.');
      }
      stage = 'terms request';
      final api = ref.read(apiClientProvider);
      final pending = await api.post('/connections/perpl/enrollment',
          decode: (v) => Map<String, dynamic>.from(v as Map));
      pendingId = pending['connectionId'] as String;
      final typed = Map<String, Object?>.from(pending['typedData'] as Map);
      perplEnrollmentPreimage(typed,
          address: address,
          chainId: chainId,
          origin: origin,
          now: DateTime.now());
      final terms = Map<String, dynamic>.from(typed['message'] as Map);
      if (terms['builderId'] != '${capability['builderId']}' ||
          terms['maxBuilderFeePer100K'] != '0' ||
          terms['origin'] != origin ||
          terms['scope'] != '3') {
        throw const WalletException('Perpl trade-only terms mismatch.');
      }
      if (!mounted) throw StateError('Enrollment screen closed.');
      stage = 'terms review';
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
                            '${capability['environment'].toString().toUpperCase()} · Chain $chainId · Account $accountId'),
                        SelectableText(address),
                        const SizedBox(height: 12),
                        Text(terms['statement'] as String),
                        const Text('Read and trade only. No withdrawals.'),
                        Text('Origin: $origin'),
                        Text('Builder ${terms['builderId']} · Fee 0%'),
                        Text(
                            'Expiry: ${DateTime.fromMillisecondsSinceEpoch(int.parse(terms['expiresAt'] as String), isUtc: true).toIso8601String()} UTC'),
                        const Text(
                            'API credentials are encrypted on the Eyeler server. Disconnecting blocks further Eyeler use; revoke the key on Perpl to remove its venue permission.'),
                      ])),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(context, false),
                        child: const Text('CANCEL')),
                    FilledButton(
                        onPressed: () => Navigator.pop(context, true),
                        child: const Text('CONTINUE TO FINGERPRINT'))
                  ]));
      if (confirmed != true) {
        await api.post('/connections/perpl/$pendingId/disconnect',
            decode: (_) => true);
        pendingId = null;
        return;
      }
      stage = 'passkey unlock';
      final wallet = ref.read(walletConnectorProvider);
      final connection = await wallet.connect();
      if (connection.address.toLowerCase() != address.toLowerCase() ||
          connection.chainId != chainId) {
        throw const WalletException(
            'The passkey wallet or network differs from this session.');
      }
      stage = 'trade-only signature';
      final signature = await wallet.signTypedData(address, typed);
      stage = 'Perpl enrollment';
      signatureSubmitted = true;
      await api.post('/connections/perpl/enrollment/$pendingId/complete',
          body: {'signature': signature}, decode: (_) => true);
      pendingId = null;
      if (mounted) {
        setState(() => message =
            'Perpl key connected. Refresh Positions to verify the account.');
      }
    } catch (error) {
      if (pendingId != null && !signatureSubmitted) {
        try {
          await ref.read(apiClientProvider).post(
              '/connections/perpl/$pendingId/disconnect',
              decode: (_) => true);
        } catch (_) {
          // Keep the pending state visible for a manual refresh/review.
        }
      }
      if (mounted) {
        setState(() => message =
            'Connection not completed at $stage: ${_enrollmentFailure(error)}. Refresh status before retrying. No trade was placed.');
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
