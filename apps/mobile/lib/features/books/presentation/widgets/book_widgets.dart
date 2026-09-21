import 'package:flutter/material.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../../domain/book.dart';

class RiskStateBadge extends StatelessWidget {
  const RiskStateBadge({super.key, required this.state});
  final String? state;

  @override
  Widget build(BuildContext context) {
    final visual = KeelRiskVisual.forState(state);
    return StatusPill(
        label: visual.label, color: visual.color, icon: visual.icon);
  }
}

class RiskBanner extends StatelessWidget {
  const RiskBanner({super.key, required this.state, required this.reasons});
  final String? state;
  final List<String> reasons;

  @override
  Widget build(BuildContext context) {
    final visual = KeelRiskVisual.forState(state);
    return Card(
      color: visual.color,
      child: Padding(
        padding: const EdgeInsets.all(KeelSpacing.lg),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(visual.icon, color: visual.foreground, size: 30),
          const SizedBox(width: KeelSpacing.md),
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text(visual.label,
                    style: KeelTypography.label
                        .copyWith(color: visual.foreground, fontSize: 12)),
                const SizedBox(height: KeelSpacing.xs),
                Text(visual.description,
                    style: KeelTypography.section
                        .copyWith(color: visual.foreground)),
                if (reasons.isNotEmpty) ...[
                  const SizedBox(height: KeelSpacing.sm),
                  Text(reasons.first,
                      style: KeelTypography.body
                          .copyWith(color: visual.foreground)),
                ],
              ])),
        ]),
      ),
    );
  }
}

class ValueTile extends StatelessWidget {
  const ValueTile({super.key, required this.label, required this.value});
  final String label;
  final Object? value;

  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.symmetric(vertical: KeelSpacing.sm),
      child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text(label,
            style: KeelTypography.body.copyWith(
                color: Theme.of(context).textTheme.bodyMedium?.color)),
        Flexible(
            child: Text(value == null ? 'Unavailable' : '$value',
                textAlign: TextAlign.right,
                style: KeelTypography.metric.copyWith(fontSize: 15)))
      ]));
}

class BookMetricsCard extends StatelessWidget {
  const BookMetricsCard(
      {super.key, required this.book, required this.telemetry});
  final Book book;
  final BookTelemetry telemetry;

  @override
  Widget build(BuildContext context) {
    final distance = telemetry.liquidationDistance;
    final spent = telemetry.reserveDeployed;
    return Card(
        child: Padding(
            padding: const EdgeInsets.all(KeelSpacing.lg),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Protection health', style: KeelTypography.title),
              const SizedBox(height: KeelSpacing.lg),
              MetricGauge(
                  label: 'ESTIMATED LIQUIDATION DISTANCE',
                  value: distance,
                  maximum: (book.liquidationFloor * 2).clamp(1, 100).toDouble(),
                  threshold: book.liquidationFloor,
                  valueLabel: distance == null
                      ? 'Unavailable'
                      : '${distance.toStringAsFixed(2)}%',
                  thresholdLabel:
                      'Configured floor ${book.liquidationFloor.toStringAsFixed(2)}%'),
              const SizedBox(height: KeelSpacing.lg),
              MetricGauge(
                  label: 'DEFENSE CAP USED',
                  value: spent,
                  maximum: book.defenseCap,
                  valueLabel: spent == null
                      ? 'Unavailable'
                      : '${spent.toStringAsFixed(2)} / ${book.defenseCap.toStringAsFixed(2)}',
                  thresholdLabel:
                      'Reserve available ${_money(telemetry.reserveAvailable)}'),
              const SizedBox(height: KeelSpacing.lg),
              _MetricGrid(items: <String, String?>{
                'MARK': _money(telemetry.mark),
                'BID / ASK': telemetry.bid == null || telemetry.ask == null
                    ? null
                    : '${_money(telemetry.bid)} / ${_money(telemetry.ask)}',
                'PNL': _money(telemetry.pnl),
                'LEVERAGE': telemetry.leverage == null
                    ? null
                    : '${telemetry.leverage!.toStringAsFixed(2)}x',
                'FUNDING': telemetry.fundingRate == null
                    ? null
                    : '${(telemetry.fundingRate! * 100).toStringAsFixed(4)}%',
                'DEPTH': _money(telemetry.depthNotional)
              }),
              const SizedBox(height: KeelSpacing.md),
              Container(
                  padding: const EdgeInsets.all(KeelSpacing.md),
                  decoration: BoxDecoration(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: .05),
                      borderRadius: BorderRadius.circular(KeelRadii.small)),
                  child: Row(children: [
                    const Icon(Icons.show_chart, size: 18),
                    const SizedBox(width: KeelSpacing.sm),
                    Expanded(
                        child: Text(
                            'Mark-price history appears when the backend provides a history series.',
                            style: KeelTypography.body.copyWith(
                                color: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.color)))
                  ])),
            ])));
  }

  String _money(double? value) =>
      value == null ? 'Unavailable' : value.toStringAsFixed(2);
}

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.items});
  final Map<String, String?> items;

  @override
  Widget build(BuildContext context) => GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: 2.4,
      mainAxisSpacing: KeelSpacing.md,
      crossAxisSpacing: KeelSpacing.md,
      children: items.entries
          .map((entry) =>
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(entry.key,
                    style: KeelTypography.label.copyWith(
                        color: Theme.of(context).textTheme.bodyMedium?.color)),
                const SizedBox(height: 5),
                Text(entry.value ?? 'Unavailable',
                    style: KeelTypography.metric.copyWith(fontSize: 16))
              ]))
          .toList());
}
