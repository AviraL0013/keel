import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../data/capital_repository.dart';

class CapitalScreen extends ConsumerWidget {
  const CapitalScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final capital = ref.watch(capitalProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('CAPITAL'), actions: [IconButton(onPressed: () => ref.invalidate(capitalProvider), icon: const Icon(Icons.refresh))]),
      body: capital.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(message: friendlyError(error), onRetry: () => ref.invalidate(capitalProvider)),
        data: (snapshot) => ListView(padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl), children: [
          const Text('Capital context', style: KeelTypography.display),
          const SizedBox(height: KeelSpacing.xs),
          Text(snapshot.status == 'VALID' ? 'Authoritative balances kept separate by source.' : 'Some capital sources are unavailable.', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)),
          const SizedBox(height: KeelSpacing.lg),
          _CapitalSection(title: 'WALLET / AUSD', icon: Icons.account_balance_wallet_outlined, values: {'AUSD balance': snapshot.ausdBalance}),
          _CapitalSection(title: 'PERPL COLLATERAL', icon: Icons.swap_horiz, values: {'Available': snapshot.perplAvailable, 'Locked': snapshot.perplLocked}),
          _CapitalSection(title: 'KEEL BOOKS', icon: Icons.shield_outlined, values: {'Reserved': snapshot.bookReserved, 'Deployed': snapshot.bookDeployed, 'Remaining': snapshot.bookRemaining, 'Unreserved': snapshot.unreservedCapital}),
        ]),
      ),
    );
  }
}

class _CapitalSection extends StatelessWidget {
  const _CapitalSection({required this.title, required this.icon, required this.values});
  final String title;
  final IconData icon;
  final Map<String, double?> values;

  @override
  Widget build(BuildContext context) {
    final known = values.values.whereType<double>().fold<double>(0, (sum, value) => sum + value);
    final maximum = known == 0 ? null : known;
    return Card(margin: const EdgeInsets.only(bottom: KeelSpacing.md), child: Padding(padding: const EdgeInsets.all(KeelSpacing.lg), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [Icon(icon, color: Theme.of(context).colorScheme.primary), const SizedBox(width: KeelSpacing.sm), Text(title, style: KeelTypography.label)]),
      const SizedBox(height: KeelSpacing.lg),
      ...values.entries.map((entry) => Padding(padding: const EdgeInsets.only(bottom: KeelSpacing.md), child: MetricGauge(label: entry.key, value: entry.value, maximum: maximum, valueLabel: entry.value == null ? 'Unavailable' : entry.value!.toStringAsFixed(2)))),
    ])));
  }
}
