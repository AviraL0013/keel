import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../../activation/activate_perpl_route.dart';
import '../../auth/data/auth_repository.dart';
import '../../books/presentation/screens/books_screen.dart';
import '../../capital/presentation/capital_screen.dart';
import '../../capital/presentation/receive_screen.dart';
import 'trading_entry_route.dart';
import '../../positions/presentation/perpl_connection_panel.dart';
import '../../positions/presentation/positions_screen.dart';
import '../data/onboarding_repository.dart';
import '../domain/onboarding_progress.dart';
import 'wallet_recovery_screen.dart';

class OnboardingHome extends ConsumerWidget {
  const OnboardingHome({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) => ref
      .watch(onboardingProvider)
      .when(
        loading: () =>
            const Scaffold(body: Center(child: CircularProgressIndicator())),
        error: (error, _) => OnboardingScreen(error: error),
        data: (progress) => progress.step == OnboardingStep.complete
            ? const BooksScreen()
            : OnboardingScreen(progress: progress),
      );
}

class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key, this.progress, this.error});
  final OnboardingProgress? progress;
  final Object? error;
  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  Future<void> _open(Widget page) async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => page));
    if (mounted) refreshOnboarding(ref);
  }

  @override
  Widget build(BuildContext context) {
    final progress = widget.progress;
    final address = ref.watch(authProvider).address;
    final mera = ref.watch(walletConnectorProvider).supportsAccountCreation;
    final step = progress?.step ?? OnboardingStep.unavailable;
    final mainnet = (progress?.environment ??
            const String.fromEnvironment('EYELER_DEPLOYMENT',
                defaultValue: 'testnet')) ==
        'mainnet';
    final (title, description, action) = switch (step) {
      OnboardingStep.fundWallet => (
          'Your wallet. Your starting point.',
          'Receive AUSD for trading and a little MON for network fees. Use only Monad mainnet.',
          'RECEIVE MON & AUSD'
        ),
      OnboardingStep.activatePerpl => (
          'Unlock your trading account.',
          mainnet
              ? 'Review each step: exact AUSD approval, account deposit, trade-only access, and order forwarding.'
              : 'Connect your own Perpl testnet account. Activate and fund it on Perpl, then refresh here.',
          'ACTIVATE PERPL'
        ),
      OnboardingStep.fundCollateral => (
          'Add trading collateral.',
          'Your account is connected. Deposit collateral into this same Perpl account to place a trade.',
          'OPEN PERPL'
        ),
      OnboardingStep.firstTrade => (
          'Make your first move.',
          'Choose a market, direction and size. Review collateral, fees and your slippage limit before confirming.',
          'OPEN FIRST POSITION'
        ),
      OnboardingStep.protectPosition => (
          'Give your position a plan.',
          'Create a Book from your verified position. Set a liquidation floor, defense budget and time limit. Automation starts only when you enable it.',
          'PROTECT A POSITION'
        ),
      OnboardingStep.complete => (
          'You’re ready.',
          'Your wallet, account and protection plan are connected.',
          'VIEW BOOKS'
        ),
      OnboardingStep.unavailable => (
          'Let’s verify your setup.',
          progress?.reason ?? _errorMessage(widget.error),
          'CHECK AGAIN'
        ),
    };
    return Scaffold(
      appBar: AppBar(title: const Text('Your trading journey'), actions: [
        IconButton(
            tooltip: 'Refresh setup',
            onPressed: () => refreshOnboarding(ref),
            icon: const Icon(Icons.refresh)),
      ]),
      body: SafeArea(
          child: Center(
              child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: RefreshIndicator(
          onRefresh: () async {
            refreshOnboarding(ref);
            try {
              await ref.read(onboardingProvider.future);
            } catch (_) {}
          },
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(EyelerSpacing.md),
            children: [
              Wrap(spacing: 8, runSpacing: 8, children: [
                StatusPill(
                    label: mera ? 'MERA PASSKEY' : 'BROWSER WALLET',
                    icon: Icons.fingerprint),
                StatusPill(
                    label: mainnet
                        ? 'MONAD MAINNET · 143'
                        : 'TESTNET / DEVELOPMENT',
                    icon: Icons.public),
              ]),
              const SizedBox(height: 24),
              Text(title,
                  style: EyelerTypography.display.copyWith(fontSize: 34)),
              const SizedBox(height: 12),
              Text(description, style: EyelerTypography.body),
              const SizedBox(height: 24),
              EyelerPanel(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    const Text('SIGNED-IN WALLET',
                        style: EyelerTypography.label),
                    const SizedBox(height: 8),
                    SelectableText(address ?? 'Session unavailable'),
                    if (progress?.accountId != null)
                      Text('Perpl account ${progress!.accountId}'),
                    const SizedBox(height: 20),
                    Text(
                        progress?.walletBalance.isAvailable == true
                            ? '${progress!.walletBalance.amount} AUSD'
                            : 'AUSD balance unavailable',
                        style: EyelerTypography.title),
                    const Text('Wallet balance · Agora AUSD on Monad'),
                    if (progress?.walletBalance.updatedAt != null)
                      Text(
                          'Observed ${progress!.walletBalance.updatedAt!.toLocal()}'),
                    if (progress?.collateral.isAvailable == true) ...[
                      const SizedBox(height: 12),
                      Text(
                          '${progress!.collateral.amount} ${progress.collateral.asset} available on Perpl'),
                    ],
                    const SizedBox(height: 12),
                    TextButton.icon(
                        onPressed: () => _open(const CapitalScreen()),
                        icon: const Icon(Icons.account_balance_wallet_outlined),
                        label: const Text('BALANCE DETAILS')),
                  ])),
              EyelerPanel(
                  child: Column(children: [
                const _JourneyRow(
                    label: '1. Sign in with your wallet', complete: true),
                _JourneyRow(
                    label: '2. Fund & activate Perpl',
                    complete: progress?.activated == true,
                    active: [
                      OnboardingStep.fundWallet,
                      OnboardingStep.activatePerpl,
                      OnboardingStep.fundCollateral
                    ].contains(step)),
                _JourneyRow(
                    label: '3. Place a trade',
                    complete: [
                      OnboardingStep.protectPosition,
                      OnboardingStep.complete
                    ].contains(step),
                    active: step == OnboardingStep.firstTrade),
                _JourneyRow(
                    label: '4. Protect it with a Book',
                    complete: step == OnboardingStep.complete,
                    active: step == OnboardingStep.protectPosition),
              ])),
              if (!mera)
                const Padding(
                    padding: EdgeInsets.only(bottom: 16),
                    child: Text(
                        'The Android app uses Mera passkeys. This browser uses an extension wallet; native Mera activation requires the Android build.')),
              if (!mainnet && progress != null)
                const Padding(
                    padding: EdgeInsets.only(bottom: 16),
                    child: Text(
                        'Testnet rehearsal uses USD collateral. Mainnet AUSD and testnet USD are separate balances.')),
              FilledButton.icon(
                icon: const Icon(Icons.arrow_forward),
                label: Text(action),
                onPressed: () async {
                  switch (step) {
                    case OnboardingStep.fundWallet:
                      if (address != null) {
                        await _open(ReceiveScreen(address: address));
                      }
                    case OnboardingStep.activatePerpl:
                      if (mainnet && mera) {
                        await _open(const ActivatePerplRoute());
                      } else {
                        await _open(Scaffold(
                            appBar: AppBar(title: const Text('Connect Perpl')),
                            body: const SingleChildScrollView(
                                padding: EdgeInsets.all(16),
                                child: PerplConnectionPanel())));
                      }
                    case OnboardingStep.fundCollateral:
                      await launchUrl(
                          Uri.parse(mainnet
                              ? 'https://app.perpl.xyz'
                              : 'https://testnet.perpl.xyz'),
                          mode: LaunchMode.externalApplication);
                    case OnboardingStep.firstTrade:
                      await _open(const TradingEntryRoute());
                    case OnboardingStep.protectPosition:
                      await _open(const PositionsScreen());
                    case OnboardingStep.complete:
                      await _open(const BooksScreen());
                    case OnboardingStep.unavailable:
                      refreshOnboarding(ref);
                  }
                },
              ),
              if (mainnet &&
                  mera &&
                  [OnboardingStep.fundWallet, OnboardingStep.unavailable]
                      .contains(step))
                TextButton(
                    onPressed: () => _open(const ActivatePerplRoute()),
                    child: const Text('ALREADY DEPOSITED? CHECK ACTIVATION')),
              if (mera)
                TextButton.icon(
                    onPressed: () => _open(const WalletRecoveryScreen()),
                    icon: const Icon(Icons.key_outlined),
                    label: const Text('CHECK PASSKEY RECOVERY')),
              TextButton(
                  onPressed: () => _open(const BooksScreen()),
                  child: const Text('EXPLORE BOOKS')),
            ],
          ),
        ),
      ))),
    );
  }

  String _errorMessage(Object? error) => error is StateError
      ? error.message.toString()
      : 'Your wallet or Perpl details are unavailable. Check your connection and retry.';
}

class _JourneyRow extends StatelessWidget {
  const _JourneyRow(
      {required this.label, required this.complete, this.active = false});
  final String label;
  final bool complete, active;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(children: [
        Icon(
            complete
                ? Icons.check_circle
                : active
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked,
            color: complete || active
                ? Theme.of(context).colorScheme.primary
                : Theme.of(context).colorScheme.outline),
        const SizedBox(width: 12),
        Expanded(
            child: Text(label,
                style: TextStyle(
                    fontWeight: active ? FontWeight.w700 : FontWeight.w400))),
      ]));
}
