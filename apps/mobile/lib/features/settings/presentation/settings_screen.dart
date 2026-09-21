import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/errors/keel_exception.dart';
import '../../../core/networking/backend_status.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/theme_controller.dart';
import '../../auth/data/auth_repository.dart';
import '../../capital/data/capital_repository.dart';
import '../data/settings_repository.dart';

class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});
  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool killEnabled = false;
  bool busy = false;

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);
    final backend = ref.watch(backendStatusProvider);
    final capital = ref.watch(capitalProvider);
    final themeMode = ref.watch(themeModeProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('SETTINGS')),
      body: ListView(
          padding: const EdgeInsets.fromLTRB(
              KeelSpacing.md, KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl),
          children: [
            const Text('Control plane', style: KeelTypography.display),
            const SizedBox(height: KeelSpacing.lg),
            Card(
                child: Padding(
                    padding: const EdgeInsets.all(KeelSpacing.lg),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('SESSION', style: KeelTypography.label),
                          const SizedBox(height: KeelSpacing.md),
                          _SettingRow(
                              label: 'Wallet',
                              value: auth.address == null
                                  ? 'Unavailable'
                                  : '${auth.address!.substring(0, 6)}...${auth.address!.substring(auth.address!.length - 4)}  Connected',
                              icon: Icons.account_balance_wallet_outlined),
                          _SettingRow(
                              label: 'KEEL session',
                              value: auth.authenticated
                                  ? 'Authenticated'
                                  : 'Disconnected',
                              icon: Icons.verified_user_outlined),
                          backend.when(
                              data: (value) => _SettingRow(
                                  label: 'Backend',
                                  value: value.state == BackendState.live
                                      ? _environmentLabel(value.environment)
                                      : 'OFFLINE',
                                  icon: Icons.dns_outlined),
                              loading: () => const _SettingRow(
                                  label: 'Backend',
                                  value: 'Checking',
                                  icon: Icons.dns_outlined),
                              error: (_, __) => const _SettingRow(
                                  label: 'Backend',
                                  value: 'Unavailable',
                                  icon: Icons.dns_outlined)),
                          capital.when(
                              data: (value) => _SettingRow(
                                  label: 'Perpl',
                                  value: value.accountId == null
                                      ? 'Unavailable'
                                      : 'Account ${value.accountId}  Connected',
                                  icon: Icons.link),
                              loading: () => const _SettingRow(
                                  label: 'Perpl',
                                  value: 'Checking',
                                  icon: Icons.link),
                              error: (_, __) => const _SettingRow(
                                  label: 'Perpl',
                                  value: 'Unavailable',
                                  icon: Icons.link)),
                        ]))),
            const SizedBox(height: KeelSpacing.md),
            Card(
                child: SwitchListTile(
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: KeelSpacing.lg),
                    title: Text(
                        killEnabled ? 'AUTOMATION DISABLED' : 'KILL SWITCH',
                        style: KeelTypography.section),
                    subtitle: Text(
                        killEnabled
                            ? 'Backend enforcement is active across automation.'
                            : 'Fail closed across automated actions.',
                        style: KeelTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    value: killEnabled,
                    onChanged: busy || killEnabled
                        ? null
                        : (_) => _confirmKillSwitch())),
            Card(
                child: SwitchListTile(
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: KeelSpacing.lg),
                    title: const Text('BRIGHT SUNLIGHT MODE',
                        style: KeelTypography.section),
                    subtitle: Text(
                        themeMode == ThemeMode.light
                            ? 'Light theme enabled.'
                            : 'Dark theme enabled by default.',
                        style: KeelTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    value: themeMode == ThemeMode.light,
                    onChanged: (value) => ref
                        .read(themeModeProvider.notifier)
                        .state = value ? ThemeMode.light : ThemeMode.dark)),
            if (backend.maybeWhen(
                data: (value) => value.environment == 'test',
                orElse: () => false)) ...[
              const SizedBox(height: KeelSpacing.md),
              Card(
                  child: Padding(
                      padding: const EdgeInsets.all(KeelSpacing.lg),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('DEV / TEST VENUE',
                                style: KeelTypography.label),
                            const SizedBox(height: KeelSpacing.xs),
                            Text(
                                'Change deterministic telemetry through the backend test adapter.',
                                style: KeelTypography.body.copyWith(
                                    color: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.color)),
                            const SizedBox(height: KeelSpacing.md),
                            Wrap(
                                spacing: KeelSpacing.sm,
                                runSpacing: KeelSpacing.sm,
                                children: [
                                  _scenario('Healthy', 'healthy'),
                                  _scenario('Floor breach', 'floor-breach'),
                                  _scenario('Deterioration', 'deterioration'),
                                  _scenario('Stale', 'stale')
                                ])
                          ])))
            ],
            if (busy)
              const Padding(
                  padding: EdgeInsets.symmetric(vertical: KeelSpacing.md),
                  child: LinearProgressIndicator()),
            const SizedBox(height: KeelSpacing.lg),
            OutlinedButton.icon(
                onPressed: busy
                    ? null
                    : () => ref.read(authProvider.notifier).logout(),
                icon: const Icon(Icons.logout),
                label: const Text('LOG OUT')),
          ]),
    );
  }

  String _environmentLabel(String? environment) => switch (environment) {
        'test' => 'DEV / TEST VENUE',
        'mainnet' => 'LIVE TESTNET',
        'development' => 'LOCAL DEV',
        _ => environment?.toUpperCase() ?? 'UNKNOWN',
      };

  Future<void> _confirmKillSwitch() async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
                title: const Text('Enable kill switch?'),
                content: const Text(
                    'The backend will block automation until an explicit recovery action. This is a fail-closed control.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('CANCEL')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('ENABLE'))
                ]));
    if (confirmed != true) return;
    setState(() => busy = true);
    try {
      await ref.read(settingsRepositoryProvider).killSwitch();
      if (mounted)
        setState(() {
          killEnabled = true;
          busy = false;
        });
    } catch (error) {
      if (mounted) {
        setState(() => busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(friendlyError(error))));
      }
    }
  }

  Widget _scenario(String label, String value) => OutlinedButton(
      onPressed: busy ? null : () => _setScenario(value), child: Text(label));
  Future<void> _setScenario(String value) async {
    setState(() => busy = true);
    try {
      await ref.read(settingsRepositoryProvider).scenario(value);
      if (mounted) setState(() => busy = false);
    } catch (error) {
      if (mounted) {
        setState(() => busy = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(friendlyError(error))));
      }
    }
  }
}

class _SettingRow extends StatelessWidget {
  const _SettingRow(
      {required this.label, required this.value, required this.icon});
  final String label;
  final String value;
  final IconData icon;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.only(bottom: KeelSpacing.md),
      child: Row(children: [
        Icon(icon, size: 18, color: Theme.of(context).colorScheme.primary),
        const SizedBox(width: KeelSpacing.sm),
        Expanded(
            child: Text(label,
                style: KeelTypography.body.copyWith(
                    color: Theme.of(context).textTheme.bodyMedium?.color))),
        Text(value, style: KeelTypography.section.copyWith(fontSize: 13))
      ]));
}
