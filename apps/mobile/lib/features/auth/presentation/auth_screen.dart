import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/backend_status.dart';
import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/keel_widgets.dart';
import '../data/auth_repository.dart';
import '../domain/auth_state.dart';

class AuthScreen extends ConsumerWidget {
  const AuthScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    final backend = ref.watch(backendStatusProvider);
    final step = auth.authenticated ? 3 : auth.walletStatus == WalletStatus.signing ? 2 : auth.address != null ? 1 : 0;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: ListView(padding: const EdgeInsets.fromLTRB(KeelSpacing.lg, KeelSpacing.lg, KeelSpacing.lg, KeelSpacing.xl), children: [
              const _BrandHeader(),
              const SizedBox(height: KeelSpacing.xl),
              Text('Protect positions\nwith confidence.', style: KeelTypography.display.copyWith(fontSize: 42)),
              const SizedBox(height: KeelSpacing.md),
              Text('KEEL watches position, reserve, market depth, and execution evidence behind every bounded action.', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)),
              const SizedBox(height: KeelSpacing.lg),
              _EnvironmentCard(status: backend),
              const SizedBox(height: KeelSpacing.md),
              Card(child: Padding(padding: const EdgeInsets.all(KeelSpacing.lg), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Secure wallet sign-in', style: KeelTypography.title),
                const SizedBox(height: KeelSpacing.xs),
                Text('Your wallet proves ownership. KEEL never receives your private key or Perpl credentials.', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)),
                const SizedBox(height: KeelSpacing.lg),
                _Step(index: 1, title: 'Connect wallet', description: 'Your provider supplies the connected address.', active: step == 0, complete: step > 0, child: SizedBox(width: double.infinity, child: FilledButton.icon(onPressed: auth.loading ? null : () => ref.read(authProvider.notifier).connectAndAuthenticate(), icon: const Icon(Icons.account_balance_wallet_outlined), label: Text(auth.walletStatus == WalletStatus.connecting ? 'CONNECTING...' : 'CONNECT WALLET')))),
                _Step(index: 2, title: 'Sign this exact message', description: 'A one-time signature binds this session to your wallet.', active: step == 2, complete: step > 2, child: auth.challengeMessage == null ? const Text('The message appears after the wallet connects.') : Container(padding: const EdgeInsets.all(KeelSpacing.md), decoration: BoxDecoration(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: .06), borderRadius: BorderRadius.circular(KeelRadii.small)), child: Row(children: [Expanded(child: Text(auth.challengeMessage!, maxLines: 4, overflow: TextOverflow.ellipsis)), IconButton(onPressed: () => Clipboard.setData(ClipboardData(text: auth.challengeMessage!)), icon: const Icon(Icons.copy))]))),
                _Step(index: 3, title: 'Verify session', description: 'Your wallet provider returns the signature; KEEL verifies it server-side.', active: auth.loading && step == 2, complete: auth.authenticated, child: Text(auth.authenticated ? 'SESSION AUTHENTICATED' : auth.walletStatus == WalletStatus.signing ? 'WAITING FOR WALLET SIGNATURE...' : 'Ready after the signature is verified.', style: KeelTypography.label.copyWith(color: auth.authenticated ? KeelColors.defend : Theme.of(context).textTheme.bodyMedium?.color))),
                if (auth.error != null) ...[const SizedBox(height: KeelSpacing.md), Text(_friendly(auth.error!), style: KeelTypography.body.copyWith(color: KeelColors.exit))],
                if (auth.loading) ...[const SizedBox(height: KeelSpacing.md), const LinearProgressIndicator(minHeight: 4)],
              ]))),
              const SizedBox(height: KeelSpacing.md),
              Text('Wallet / KEEL session / server-side Perpl account', textAlign: TextAlign.center, style: KeelTypography.label.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color, fontSize: 10)),
            ]),
          ),
        ),
      ),
    );
  }

  static String _friendly(String value) => value.replaceFirst('WalletException: ', '').replaceFirst('KeelException: ', '');
}

class _Step extends StatelessWidget {
  const _Step({required this.index, required this.title, required this.description, required this.active, required this.complete, required this.child});
  final int index;
  final String title;
  final String description;
  final bool active;
  final bool complete;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.only(bottom: KeelSpacing.lg), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Container(width: 30, height: 30, decoration: BoxDecoration(color: complete ? KeelColors.defend : active ? KeelColors.accent : Theme.of(context).colorScheme.onSurface.withValues(alpha: .1), shape: BoxShape.circle), child: Center(child: complete ? const Icon(Icons.check, size: 16, color: Colors.black) : Text('$index', style: const TextStyle(fontWeight: FontWeight.w800, color: Colors.black)))), const SizedBox(width: KeelSpacing.md), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, style: KeelTypography.section), const SizedBox(height: 4), Text(description, style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)), const SizedBox(height: KeelSpacing.sm), child]))]));
}

class _BrandHeader extends StatelessWidget {
  const _BrandHeader();
  @override
  Widget build(BuildContext context) => Row(children: [Container(width: 44, height: 44, decoration: BoxDecoration(color: KeelColors.accent, borderRadius: BorderRadius.circular(14)), child: const Icon(Icons.sailing, color: Colors.black)), const SizedBox(width: 12), const Expanded(child: Text('KEEL', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w900, letterSpacing: 1.5))), const StatusPill(label: 'DEV / TEST VENUE', color: KeelColors.info)]);
}

class _EnvironmentCard extends StatelessWidget {
  const _EnvironmentCard({required this.status});
  final AsyncValue<BackendStatus> status;
  @override
  Widget build(BuildContext context) {
    return Card(child: Padding(padding: const EdgeInsets.all(KeelSpacing.md), child: Row(children: [
      const Icon(Icons.dns_outlined, color: KeelColors.info),
      const SizedBox(width: KeelSpacing.sm),
      Expanded(child: status.when(
        data: (value) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(value.state == BackendState.live ? 'BACKEND LIVE' : 'BACKEND OFFLINE', style: KeelTypography.label),
          Text(value.environment == 'test' ? 'Deterministic test venue' : value.environment?.toUpperCase() ?? 'Connection unavailable', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)),
        ]),
        loading: () => const Text('CONNECTING TO KEEL...'),
        error: (_, __) => const Text('KEEL SERVER UNAVAILABLE'),
      )),
    ])));
  }
}
