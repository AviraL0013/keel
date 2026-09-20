import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../data/positions_repository.dart';
import '../domain/position.dart';
import '../../books/presentation/screens/create_book_screen.dart';

class PositionsScreen extends ConsumerWidget {
  const PositionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final positions = ref.watch(positionsProvider);
    final connection = ref.watch(perplConnectionProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('POSITIONS'), actions: [IconButton(onPressed: () { ref.invalidate(positionsProvider); ref.invalidate(perplConnectionProvider); }, icon: const Icon(Icons.refresh))]),
      body: positions.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(message: friendlyError(error), onRetry: () => ref.invalidate(positionsProvider)),
        data: (items) => RefreshIndicator(
          onRefresh: () async { ref.invalidate(positionsProvider); ref.invalidate(perplConnectionProvider); },
          child: ListView(padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl), children: [
            const Text('Your positions', style: KeelTypography.display),
            const SizedBox(height: KeelSpacing.xs),
            Text('Choose an OPEN position to configure protection.', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)),
            const SizedBox(height: KeelSpacing.md),
            connection.when(
              data: (value) => Card(child: Padding(padding: const EdgeInsets.all(KeelSpacing.md), child: Row(children: [Icon(value.status == 'VALID' ? Icons.link : Icons.link_off, color: value.status == 'VALID' ? KeelColors.defend : KeelColors.reduce), const SizedBox(width: KeelSpacing.sm), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('PERPL / ${value.status}', style: KeelTypography.section), Text(value.environment == null ? 'Server-side venue connection' : value.environment!.toUpperCase(), style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color))])), if (value.status != 'VALID') TextButton(onPressed: () => ref.invalidate(perplConnectionProvider), child: const Text('RETRY'))]))),
              loading: () => const LinearProgressIndicator(),
              error: (_, __) => const EmptyStateCard(icon: Icons.link_off, title: 'PERPL UNAVAILABLE', message: 'The server could not validate the configured venue connection.'),
            ),
            const SizedBox(height: KeelSpacing.md),
            if (items.isEmpty) const EmptyStateCard(icon: Icons.layers_clear_outlined, title: 'NO ACTIVE POSITIONS', message: 'Connect a Perpl account to discover positions.'),
            ...items.map((position) => _PositionCard(position: position)),
          ]),
        ),
      ),
    );
  }
}

class _PositionCard extends StatelessWidget {
  const _PositionCard({required this.position});
  final Position position;

  @override
  Widget build(BuildContext context) {
    final open = position.status == 'OPEN';
    return Card(margin: const EdgeInsets.only(bottom: KeelSpacing.md), child: Padding(padding: const EdgeInsets.all(KeelSpacing.lg), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(position.market, style: KeelTypography.title), const SizedBox(height: KeelSpacing.xs), Text('${position.side} / ${position.leverage.toStringAsFixed(2)}x', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color))]), StatusPill(label: position.status, color: open ? KeelColors.defend : KeelColors.hold, icon: open ? Icons.lock_open : Icons.lock_outline)]),
      const SizedBox(height: KeelSpacing.lg),
      _PositionMetricGrid(position: position),
      if (open) ...[
        const SizedBox(height: KeelSpacing.lg),
        SizedBox(width: double.infinity, child: FilledButton.icon(onPressed: () {
          Navigator.of(context).push(MaterialPageRoute(builder: (_) => CreateBookScreen(position: position)));
        }, icon: const Icon(Icons.shield_outlined), label: const Text('CREATE BOOK'))),
      ],
    ])));
  }
}

class _PositionMetricGrid extends StatelessWidget {
  const _PositionMetricGrid({required this.position});
  final Position position;
  @override
  Widget build(BuildContext context) => GridView.count(crossAxisCount: 2, shrinkWrap: true, physics: const NeverScrollableScrollPhysics(), childAspectRatio: 2.5, mainAxisSpacing: KeelSpacing.md, children: [_Metric('SIZE', _number(position.size)), _Metric('ENTRY', _number(position.entryPrice)), _Metric('MARK', _number(position.markPrice)), _Metric('PNL', _number(position.pnl)), _Metric('LIQUIDATION', _number(position.liquidationPrice)), _Metric('MARGIN', _number(position.margin))]);
  String _number(double? value) => value == null ? 'Unavailable' : value.toStringAsFixed(2);
}

class _Metric extends StatelessWidget {
  const _Metric(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(label, style: KeelTypography.label.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)), const SizedBox(height: 4), Text(value, style: KeelTypography.metric.copyWith(fontSize: 16))]);
}
