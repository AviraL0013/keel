import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/errors/eyeler_exception.dart';
import '../../../core/networking/backend_status.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/theme/theme_controller.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../../auth/data/auth_repository.dart';
import '../../capital/data/capital_repository.dart';
import '../data/settings_repository.dart';
import 'telegram_panel.dart';
import '../../positions/presentation/perpl_connection_panel.dart';

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
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
          padding: const EdgeInsets.fromLTRB(EyelerSpacing.md, EyelerSpacing.sm,
              EyelerSpacing.md, EyelerSpacing.xl),
          children: [
            const Text('Your EYELER settings', style: EyelerTypography.display),
            const SizedBox(height: EyelerSpacing.lg),
            const TelegramPanel(),
            const PerplConnectionPanel(),
            const SizedBox(height: EyelerSpacing.md),
            EyelerPanel(
                child: Padding(
                    padding: EdgeInsets.zero,
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Account & session',
                              style: EyelerTypography.title),
                          const SizedBox(height: EyelerSpacing.md),
                          _SettingRow(
                              label: 'Wallet',
                              value: auth.address == null
                                  ? 'Unavailable'
                                  : '${auth.address!.substring(0, 6)}...${auth.address!.substring(auth.address!.length - 4)}  Connected',
                              icon: Icons.account_balance_wallet_outlined),
                          _SettingRow(
                              label: 'EYELER session',
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
            const SizedBox(height: EyelerSpacing.md),
            EyelerPanel(
                child: SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                        killEnabled ? 'Automation disabled' : 'Kill switch',
                        style: EyelerTypography.section),
                    subtitle: Text(
                        killEnabled
                            ? 'Backend enforcement is active across automation.'
                            : 'Fail closed across automated actions.',
                        style: EyelerTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    value: killEnabled,
                    onChanged: busy || killEnabled
                        ? null
                        : (_) => _confirmKillSwitch())),
            EyelerPanel(
                child: SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Bright sunlight mode',
                        style: EyelerTypography.section),
                    subtitle: Text(
                        themeMode == ThemeMode.light
                            ? 'Light theme enabled.'
                            : 'Dark theme enabled by default.',
                        style: EyelerTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    value: themeMode == ThemeMode.light,
                    onChanged: (value) => ref
                        .read(themeModeProvider.notifier)
                        .state = value ? ThemeMode.light : ThemeMode.dark)),
            if (backend.maybeWhen(
                data: (value) => value.environment == 'test',
                orElse: () => false)) ...[
              const SizedBox(height: EyelerSpacing.md),
              EyelerPanel(
                  child: Padding(
                      padding: EdgeInsets.zero,
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('DEV / TEST VENUE',
                                style: EyelerTypography.label),
                            const SizedBox(height: EyelerSpacing.xs),
                            Text(
                                'Change deterministic telemetry through the backend test adapter.',
                                style: EyelerTypography.body.copyWith(
                                    color: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.color)),
                            const SizedBox(height: EyelerSpacing.md),
                            Wrap(
                                spacing: EyelerSpacing.sm,
                                runSpacing: EyelerSpacing.sm,
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
                  padding: EdgeInsets.symmetric(vertical: EyelerSpacing.md),
                  child: LinearProgressIndicator()),
            const SizedBox(height: EyelerSpacing.lg),
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
        'mainnet' => 'LIVE MAINNET',
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
    if (confirmed != true) {
      return;
    }
    setState(() => busy = true);
    try {
      await ref.read(settingsRepositoryProvider).killSwitch();
      if (mounted) {
        setState(() {
          killEnabled = true;
          busy = false;
        });
      }
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
      padding: const EdgeInsets.only(bottom: EyelerSpacing.md),
      child: Row(children: [
        EyelerIconTile(icon: icon, size: 36),
        const SizedBox(width: EyelerSpacing.sm),
        Expanded(
            child: Text(label,
                style: EyelerTypography.body.copyWith(
                    color: Theme.of(context).textTheme.bodyMedium?.color))),
        Flexible(
            child: Text(value,
                textAlign: TextAlign.right,
                style: EyelerTypography.section.copyWith(fontSize: 13)))
      ]));
}
