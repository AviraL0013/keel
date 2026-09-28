import 'package:flutter/material.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/eyeler_widgets.dart';
import '../../domain/book.dart';

class RiskStateBadge extends StatelessWidget {
  const RiskStateBadge({super.key, required this.state});
  final String? state;

  @override
  Widget build(BuildContext context) {
    final visual = EyelerRiskVisual.forState(state);
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
    final visual = EyelerRiskVisual.forState(state);
    return Card(
      color: visual.color,
      child: Padding(
        padding: const EdgeInsets.all(EyelerSpacing.lg),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(visual.icon, color: visual.foreground, size: 30),
          const SizedBox(width: EyelerSpacing.md),
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text(visual.label,
                    style: EyelerTypography.label
                        .copyWith(color: visual.foreground, fontSize: 12)),
                const SizedBox(height: EyelerSpacing.xs),
                Text(visual.description,
                    style: EyelerTypography.section
                        .copyWith(color: visual.foreground)),
                if (reasons.isNotEmpty) ...[
                  const SizedBox(height: EyelerSpacing.sm),
                  Text(reasons.first,
                      style: EyelerTypography.body
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
      padding: const EdgeInsets.symmetric(vertical: EyelerSpacing.sm),
      child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text(label,
            style: EyelerTypography.body.copyWith(
                color: Theme.of(context).textTheme.bodyMedium?.color)),
        Flexible(
            child: Text(value == null ? 'Unavailable' : '$value',
                textAlign: TextAlign.right,
                style: EyelerTypography.metric.copyWith(fontSize: 15)))
      ]));
}

class BookMetricsCard extends StatelessWidget {
  const BookMetricsCard(
      {super.key,
      required this.book,
      required this.telemetry,
      this.includeTechnical = true});
  final Book book;
  final BookTelemetry telemetry;
  final bool includeTechnical;

  @override
  Widget build(BuildContext context) {
    final distance = telemetry.liquidationDistance;
    final spent = telemetry.reserveDeployed;
    return Card(
        child: Padding(
            padding: const EdgeInsets.all(EyelerSpacing.lg),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('Protection health', style: EyelerTypography.title),
              const SizedBox(height: EyelerSpacing.lg),
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
              const SizedBox(height: EyelerSpacing.lg),
              MetricGauge(
                  label: 'DEFENSE CAP USED',
                  value: spent,
                  maximum: book.defenseCap,
                  valueLabel: spent == null
                      ? 'Unavailable'
                      : '${spent.toStringAsFixed(2)} / ${book.defenseCap.toStringAsFixed(2)}',
                  thresholdLabel:
                      'Reserve available ${_money(telemetry.reserveAvailable)}'),
              if (book.status != 'CLOSED') ...[
                const SizedBox(height: EyelerSpacing.lg),
                ValueTile(
                    label: 'Unrealized P&L', value: _money(telemetry.pnl)),
              ],
              if (includeTechnical) ...[
                const SizedBox(height: EyelerSpacing.lg),
                BookTechnicalMetrics(telemetry: telemetry),
              ],
            ])));
  }

  String _money(double? value) =>
      value == null ? 'Unavailable' : value.toStringAsFixed(2);
}

class BookTechnicalMetrics extends StatelessWidget {
  const BookTechnicalMetrics({super.key, required this.telemetry});
  final BookTelemetry telemetry;

  @override
  Widget build(BuildContext context) => Column(children: [
        _MetricGrid(items: <String, String?>{
          'MARK': _money(telemetry.mark),
          'BID / ASK': telemetry.bid == null || telemetry.ask == null
              ? null
              : '${_money(telemetry.bid)} / ${_money(telemetry.ask)}',
          if (telemetry.positionStatus != 'CLOSED')
            'UNREALIZED P&L': _money(telemetry.pnl),
          'LEVERAGE': telemetry.leverage == null
              ? null
              : '${telemetry.leverage!.toStringAsFixed(2)}x',
          'FUNDING': telemetry.fundingRate == null
              ? null
              : '${(telemetry.fundingRate! * 100).toStringAsFixed(4)}%',
          'DEPTH': _money(telemetry.depthNotional)
        }),
        const SizedBox(height: EyelerSpacing.md),
        Container(
            padding: const EdgeInsets.all(EyelerSpacing.md),
            decoration: BoxDecoration(
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: .05),
                borderRadius: BorderRadius.circular(EyelerRadii.small)),
            child: Row(children: [
              const Icon(Icons.show_chart, size: 18),
              const SizedBox(width: EyelerSpacing.sm),
              Expanded(
                  child: Text(
                      'Mark-price history appears when the backend provides a history series.',
                      style: EyelerTypography.body.copyWith(
                          color:
                              Theme.of(context).textTheme.bodyMedium?.color)))
            ])),
      ]);

  String _money(double? value) =>
      value == null ? 'Unavailable' : value.toStringAsFixed(2);
}

class _MetricGrid extends StatelessWidget {
  const _MetricGrid({required this.items});
  final Map<String, String?> items;

  @override
  Widget build(BuildContext context) =>
      LayoutBuilder(builder: (context, constraints) {
        final twoColumns = constraints.maxWidth >= 260;
        final width = twoColumns
            ? (constraints.maxWidth - EyelerSpacing.md) / 2
            : constraints.maxWidth;
        return Wrap(
            spacing: EyelerSpacing.md,
            runSpacing: EyelerSpacing.md,
            children: items.entries
                .map((entry) => SizedBox(
                    width: width,
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(entry.key,
                              style: EyelerTypography.label.copyWith(
                                  color: Theme.of(context)
                                      .textTheme
                                      .bodyMedium
                                      ?.color)),
                          const SizedBox(height: 5),
                          Text(entry.value ?? 'Unavailable',
                              style:
                                  EyelerTypography.metric.copyWith(fontSize: 16))
                        ])))
                .toList());
      });
}
