import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/backend_status.dart';
import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../data/auth_repository.dart';
import '../domain/auth_state.dart';
import '../../../core/errors/eyeler_exception.dart';

class AuthScreen extends ConsumerWidget {
  const AuthScreen({super.key});

  Future<void> _createWallet(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
              title: const Text('Create a new Mera wallet?'),
              content: const Text(
                  'This creates a separate wallet. Save its passkey in a provider with sync and account recovery. EYELER cannot reset the wallet, export a seed, or recover funds if the passkey is lost. Sign in with your existing passkey if you already have an EYELER wallet.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('CANCEL')),
                FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('CREATE WALLET'))
              ],
            ));
    if (confirmed == true && context.mounted) {
      await ref
          .read(authProvider.notifier)
          .connectAndAuthenticate(createAccount: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    final backend = ref.watch(backendStatusProvider);
    final mera = ref.watch(walletConnectorProvider).supportsAccountCreation;
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
                            style: EyelerTypography.display
                                .copyWith(fontSize: 42)),
                        const SizedBox(height: EyelerSpacing.md),
                        TextButton.icon(
                          onPressed: () =>
                              Navigator.of(context).pushNamed('/analytics'),
                          icon: const Icon(Icons.analytics_outlined),
                          label: const Text('Browse public analytics'),
                        ),
                        Text(
                            'EYELER watches position, reserve, market depth, and execution evidence behind every bounded action.',
                            style: EyelerTypography.body.copyWith(
                                color: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.color)),
                        const SizedBox(height: EyelerSpacing.lg),
                        _EnvironmentCard(status: backend),
                        if (!mera)
                          const Padding(
                              padding: EdgeInsets.only(top: EyelerSpacing.md),
                              child: Text(
                                  'Browser wallet mode. Mera passkey sign-in and wallet creation are available in the Android app.')),
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
                                          'Your wallet proves ownership. Private wallet keys stay on your device. Perpl trade-only API credentials are encrypted on the server.',
                                          style: EyelerTypography.body.copyWith(
                                              color: Theme.of(context)
                                                  .textTheme
                                                  .bodyMedium
                                                  ?.color)),
                                      const SizedBox(height: EyelerSpacing.lg),
                                      _Step(
                                          index: 1,
                                          title: mera
                                              ? 'Sign in with Mera'
                                              : 'Connect wallet',
                                          description: mera
                                              ? 'Use your existing passkey to recover the same wallet.'
                                              : 'Your provider supplies the connected address.',
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
                                                      : mera
                                                          ? 'SIGN IN WITH PASSKEY'
                                                          : 'CONNECT WALLET')))),
                                      if (mera) ...[
                                        const SizedBox(
                                            height: EyelerSpacing.sm),
                                        const Text(
                                            'New here? Create a separate Mera wallet. Funds in your existing wallet do not move automatically.'),
                                        OutlinedButton(
                                            onPressed: auth.loading
                                                ? null
                                                : () =>
                                                    _createWallet(context, ref),
                                            child: const Text(
                                                'CREATE NEW MERA WALLET')),
                                      ],
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
                                                              EyelerRadii
                                                                  .small)),
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
                                        const SizedBox(
                                            height: EyelerSpacing.md),
                                        Text(_friendly(auth.error!),
                                            style: EyelerTypography.body
                                                .copyWith(
                                                    color: EyelerColors.exit))
                                      ],
                                      if (auth.error == 'WALLET_NOT_ALLOWED' &&
                                          auth.address != null) ...[
                                        const SizedBox(
                                            height: EyelerSpacing.sm),
                                        const Text(
                                            'Ask the operator to add this address.'),
                                        const SizedBox(
                                            height: EyelerSpacing.sm),
                                        Row(children: [
                                          Expanded(
                                              child: SelectableText(
                                                  auth.address!)),
                                          IconButton(
                                              tooltip: 'Copy wallet address',
                                              onPressed: () =>
                                                  Clipboard.setData(
                                                      ClipboardData(
                                                          text: auth.address!)),
                                              icon: const Icon(Icons.copy)),
                                        ]),
                                      ],
                                      if (auth.loading) ...[
                                        const SizedBox(
                                            height: EyelerSpacing.md),
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

  static String _friendly(String value) => EyelerException(value
          .replaceFirst('WalletException: ', '')
          .replaceFirst('EyelerException: ', ''))
      .userMessage;
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
        const Expanded(
            child: Align(
                alignment: Alignment.centerLeft,
                child: Image(
                    image: AssetImage('assets/branding/eyeler-lockup.png'),
                    width: 180,
                    height: 48,
                    fit: BoxFit.contain))),
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
                      if (value.demoAllowlist)
                        const Text('Demo (allowlisted)',
                            style: EyelerTypography.label),
                    ]),
                loading: () => const Text('CONNECTING TO EYELER...'),
                error: (_, __) => const Text('EYELER SERVER UNAVAILABLE'),
              )),
            ])));
  }
}
