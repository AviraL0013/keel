import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/backend_status.dart';
import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../data/auth_repository.dart';
import '../domain/auth_state.dart';

class AuthScreen extends ConsumerWidget {
  const AuthScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    final backend = ref.watch(backendStatusProvider);
    final step = auth.authenticated
        ? 3
        : auth.walletStatus == WalletStatus.signing
            ? 2
            : auth.address != null
                ? 1
                : 0;
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
            builder: (context, constraints) => Center(
                    child: SizedBox(
                  width:
                      constraints.maxWidth > 520 ? 520 : constraints.maxWidth,
                  height: constraints.maxHeight,
                  child: ListView(
                      padding: const EdgeInsets.fromLTRB(EyelerSpacing.lg,
                          EyelerSpacing.lg, EyelerSpacing.lg, EyelerSpacing.xl),
                      children: [
                        _BrandHeader(status: backend),
                        const SizedBox(height: EyelerSpacing.xl),
                        Text('Protect positions\nwith confidence.',
                            style:
                                EyelerTypography.display.copyWith(fontSize: 42)),
                        const SizedBox(height: EyelerSpacing.md),
                        Text(
                            'EYELER watches position, reserve, market depth, and execution evidence behind every bounded action.',
                            style: EyelerTypography.body.copyWith(
                                color: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.color)),
                        const SizedBox(height: EyelerSpacing.lg),
                        _EnvironmentCard(status: backend),
                        const SizedBox(height: EyelerSpacing.md),
                        EyelerPanel(
                            child: Padding(
                                padding: EdgeInsets.zero,
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      const Text('Secure wallet sign-in',
                                          style: EyelerTypography.title),
                                      const SizedBox(height: EyelerSpacing.xs),
                                      Text(
                                          'Your wallet proves ownership. EYELER never receives your private key or Perpl credentials.',
                                          style: EyelerTypography.body.copyWith(
                                              color: Theme.of(context)
                                                  .textTheme
                                                  .bodyMedium
                                                  ?.color)),
                                      const SizedBox(height: EyelerSpacing.lg),
                                      _Step(
                                          index: 1,
                                          title: 'Connect wallet',
                                          description:
                                              'Your provider supplies the connected address.',
                                          active: step == 0,
                                          complete: step > 0,
                                          child: SizedBox(
                                              width: double.infinity,
                                              child: FilledButton.icon(
                                                  onPressed: auth.loading
                                                      ? null
                                                      : () => ref
                                                          .read(authProvider
                                                              .notifier)
                                                          .connectAndAuthenticate(),
                                                  icon: const Icon(Icons
                                                      .account_balance_wallet_outlined),
                                                  label: Text(auth
                                                              .walletStatus ==
                                                          WalletStatus
                                                              .connecting
                                                      ? 'CONNECTING...'
                                                      : 'CONNECT WALLET')))),
                                      _Step(
                                          index: 2,
                                          title: 'Sign this exact message',
                                          description:
                                              'A one-time signature binds this session to your wallet.',
                                          active: step == 2,
                                          complete: step > 2,
                                          child: auth.challengeMessage == null
                                              ? const Text(
                                                  'The message appears after the wallet connects.')
                                              : Container(
                                                  padding: const EdgeInsets.all(
                                                      EyelerSpacing.md),
                                                  decoration: BoxDecoration(
                                                      color: Theme.of(context)
                                                          .colorScheme
                                                          .onSurface
                                                          .withValues(
                                                              alpha: .06),
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                              EyelerRadii.small)),
                                                  child: Row(children: [
                                                    Expanded(
                                                        child: Text(
                                                            auth
                                                                .challengeMessage!,
                                                            maxLines: 4,
                                                            overflow:
                                                                TextOverflow
                                                                    .ellipsis)),
                                                    IconButton(
                                                        onPressed: () =>
                                                            Clipboard.setData(
                                                                ClipboardData(
                                                                    text: auth
                                                                        .challengeMessage!)),
                                                        icon: const Icon(
                                                            Icons.copy))
                                                  ]))),
                                      _Step(
                                          index: 3,
                                          title: 'Verify session',
                                          description:
                                              'Your wallet provider returns the signature; EYELER verifies it server-side.',
                                          active: auth.loading && step == 2,
                                          complete: auth.authenticated,
                                          child: Text(
                                              auth.authenticated
                                                  ? 'SESSION AUTHENTICATED'
                                                  : auth.walletStatus ==
                                                          WalletStatus.signing
                                                      ? 'WAITING FOR WALLET SIGNATURE...'
                                                      : 'Ready after the signature is verified.',
                                              style: EyelerTypography.label
                                                  .copyWith(
                                                      color: auth.authenticated
                                                          ? EyelerColors.defend
                                                          : Theme.of(context)
                                                              .textTheme
                                                              .bodyMedium
                                                              ?.color))),
                                      if (auth.error != null) ...[
                                        const SizedBox(height: EyelerSpacing.md),
                                        Text(_friendly(auth.error!),
                                            style: EyelerTypography.body.copyWith(
                                                color: EyelerColors.exit))
                                      ],
                                      if (auth.loading) ...[
                                        const SizedBox(height: EyelerSpacing.md),
                                        const LinearProgressIndicator(
                                            minHeight: 4)
                                      ],
                                    ]))),
                        const SizedBox(height: EyelerSpacing.md),
                        Text(
                            'Wallet / EYELER session / server-side Perpl account',
                            textAlign: TextAlign.center,
                            style: EyelerTypography.label.copyWith(
                                color: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.color,
                                fontSize: 10)),
                      ]),
                ))),
      ),
    );
  }

  static String _friendly(String value) => value
      .replaceFirst('WalletException: ', '')
      .replaceFirst('EyelerException: ', '');
}

class _Step extends StatelessWidget {
  const _Step(
      {required this.index,
      required this.title,
      required this.description,
      required this.active,
      required this.complete,
      required this.child});
  final int index;
  final String title;
  final String description;
  final bool active;
  final bool complete;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.only(bottom: EyelerSpacing.lg),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
                color: complete
                    ? EyelerColors.defend
                    : active
                        ? EyelerColors.accent
                        : Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: .1),
                shape: BoxShape.circle),
            child: Center(
                child: complete
                    ? const Icon(Icons.check, size: 16, color: Colors.black)
                    : Text('$index',
                        style: const TextStyle(
                            fontWeight: FontWeight.w800,
                            color: Colors.black)))),
        const SizedBox(width: EyelerSpacing.md),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: EyelerTypography.section),
          const SizedBox(height: 4),
          Text(description,
              style: EyelerTypography.body.copyWith(
                  color: Theme.of(context).textTheme.bodyMedium?.color)),
          const SizedBox(height: EyelerSpacing.sm),
          child
        ]))
      ]));
}

class _BrandHeader extends StatelessWidget {
  const _BrandHeader({required this.status});
  final AsyncValue<BackendStatus> status;
  @override
  Widget build(BuildContext context) => Row(children: [
        const EyelerIconTile(icon: Icons.sailing, size: 44),
        const SizedBox(width: 12),
        const Expanded(
            child: Text('EYELER',
                style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1.5))),
        status.when(
          data: (value) => StatusPill(
              label: value.state == BackendState.live
                  ? value.environment == 'test'
                      ? 'TEST VENUE'
                      : (value.environment?.toUpperCase() ?? 'CONNECTED')
                  : 'OFFLINE',
              color: value.state == BackendState.live
                  ? EyelerColors.defend
                  : EyelerColors.reduce),
          loading: () =>
              const StatusPill(label: 'CHECKING', color: EyelerColors.reduce),
          error: (_, __) =>
              const StatusPill(label: 'OFFLINE', color: EyelerColors.reduce),
        )
      ]);
}

class _EnvironmentCard extends StatelessWidget {
  const _EnvironmentCard({required this.status});
  final AsyncValue<BackendStatus> status;
  @override
  Widget build(BuildContext context) {
    return EyelerPanel(
        child: Padding(
            padding: EdgeInsets.zero,
            child: Row(children: [
              const EyelerIconTile(icon: Icons.dns_outlined, size: 40),
              const SizedBox(width: EyelerSpacing.sm),
              Expanded(
                  child: status.when(
                data: (value) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                          value.state == BackendState.live
                              ? 'BACKEND LIVE'
                              : 'BACKEND OFFLINE',
                          style: EyelerTypography.label),
                      Text(
                          value.environment == 'test'
                              ? 'Deterministic test venue'
                              : value.environment?.toUpperCase() ??
                                  'Connection unavailable',
                          style: EyelerTypography.body.copyWith(
                              color: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.color)),
                    ]),
                loading: () => const Text('CONNECTING TO EYELER...'),
                error: (_, __) => const Text('EYELER SERVER UNAVAILABLE'),
              )),
            ])));
  }
}
