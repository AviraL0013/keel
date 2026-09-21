import 'package:flutter/material.dart';
import '../../core/theme/app_theme.dart';
import '../models/telemetry_freshness.dart';

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, this.color, this.icon});
  final String label;
  final Color? color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final tone = color ?? Theme.of(context).colorScheme.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: .18),
        borderRadius: BorderRadius.circular(KeelRadii.pill),
        border: Border.all(color: tone.withValues(alpha: .5)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[
          Icon(icon, size: 14, color: tone),
          const SizedBox(width: 6)
        ],
        Flexible(
            child: Text(label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                softWrap: true,
                style: KeelTypography.label
                    .copyWith(color: tone, fontSize: 10, letterSpacing: .6))),
      ]),
    );
  }
}

class MetricGauge extends StatelessWidget {
  const MetricGauge(
      {super.key,
      required this.label,
      required this.value,
      required this.maximum,
      required this.valueLabel,
      this.threshold,
      this.thresholdLabel});
  final String label;
  final double? value;
  final double? maximum;
  final String valueLabel;
  final double? threshold;
  final String? thresholdLabel;

  @override
  Widget build(BuildContext context) {
    final ratio = value == null || maximum == null || maximum == 0
        ? null
        : (value! / maximum!).clamp(0.0, 1.0);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text(label,
            style: KeelTypography.label.copyWith(
                color: Theme.of(context).textTheme.bodyMedium?.color)),
        Text(valueLabel, style: KeelTypography.metric.copyWith(fontSize: 16)),
      ]),
      const SizedBox(height: KeelSpacing.sm),
      LayoutBuilder(builder: (_, constraints) {
        return Stack(children: [
          Container(
              height: 10,
              decoration: BoxDecoration(
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: .1),
                  borderRadius: BorderRadius.circular(100))),
          if (ratio != null)
            Align(
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                    widthFactor: ratio,
                    child: Container(
                        height: 10,
                        decoration: BoxDecoration(
                            color: KeelColors.defend,
                            borderRadius: BorderRadius.circular(100))))),
          if (threshold != null && maximum != null)
            Positioned(
                left: (constraints.maxWidth *
                        (threshold! / maximum!).clamp(0.0, 1.0)) -
                    1,
                top: -3,
                child:
                    Container(width: 3, height: 16, color: KeelColors.reduce)),
        ]);
      }),
      if (thresholdLabel != null) ...[
        const SizedBox(height: 6),
        Text(thresholdLabel!,
            style: KeelTypography.body.copyWith(
                fontSize: 12,
                color: Theme.of(context).textTheme.bodyMedium?.color)),
      ],
    ]);
  }
}

class TelemetryFreshness extends StatelessWidget {
  const TelemetryFreshness({super.key, this.freshness, this.freshnessMs});
  final TelemetryFreshnessModel? freshness;
  final int? freshnessMs;

  @override
  Widget build(BuildContext context) {
    if (freshness != null) {
      return Wrap(
          spacing: KeelSpacing.sm,
          runSpacing: KeelSpacing.xs,
          children: [
            _source(context, 'MARKET', freshness!.market),
            _source(context, 'POSITION', freshness!.position),
            _source(context, 'FUNDING', freshness!.funding),
            _source(context, 'DEPTH', freshness!.orderbook),
          ]);
    }
    return Wrap(spacing: KeelSpacing.sm, runSpacing: KeelSpacing.xs, children: [
      for (final source in ['MARKET', 'POSITION', 'FUNDING', 'DEPTH'])
        StatusPill(label: '$source UNKNOWN', color: KeelColors.hold, icon: Icons.help_outline),
    ]);
  }

  Widget _source(
      BuildContext context, String label, TelemetryFreshnessPoint point) {
    final color = point.stale
        ? KeelColors.reduce
        : point.fresh
            ? KeelColors.defend
            : KeelColors.hold;
    final status = point.fresh ? 'LIVE' : point.stale ? 'STALE' : point.status == 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UNKNOWN';
    return StatusPill(
        label: '$label $status',
        color: color,
        icon: point.stale
            ? Icons.sync_problem
            : point.fresh
                ? Icons.wifi_tethering
                : Icons.help_outline);
  }


}

class ActionButtonRow extends StatelessWidget {
  const ActionButtonRow(
      {super.key,
      required this.onDefend,
      required this.onReduce,
      required this.onExit,
      this.disabled = false});
  final VoidCallback? onDefend;
  final VoidCallback? onReduce;
  final VoidCallback? onExit;
  final bool disabled;

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      Expanded(
          child: FilledButton.icon(
              onPressed: disabled ? null : onDefend,
              icon: const Icon(Icons.shield_outlined, size: 17),
              label: const Text('DEFEND'))),
      const SizedBox(width: KeelSpacing.sm),
      Expanded(
          child: OutlinedButton.icon(
              onPressed: disabled ? null : onReduce,
              icon: const Icon(Icons.trending_down, size: 17),
              label: const Text('REDUCE'))),
      const SizedBox(width: KeelSpacing.sm),
      Expanded(
          child: OutlinedButton.icon(
              onPressed: disabled ? null : onExit,
              icon: const Icon(Icons.logout, size: 17),
              label: const Text('EXIT'))),
    ]);
  }
}

class EmptyStateCard extends StatelessWidget {
  const EmptyStateCard(
      {super.key,
      required this.icon,
      required this.title,
      required this.message,
      this.action});
  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Card(
        child: Padding(
            padding: const EdgeInsets.all(KeelSpacing.lg),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(icon,
                  size: 30, color: Theme.of(context).colorScheme.primary),
              const SizedBox(height: KeelSpacing.md),
              Text(title, style: KeelTypography.section),
              const SizedBox(height: KeelSpacing.xs),
              Text(message,
                  style: KeelTypography.body.copyWith(
                      color: Theme.of(context).textTheme.bodyMedium?.color)),
              if (action != null) ...[
                const SizedBox(height: KeelSpacing.md),
                action!
              ],
            ])));
  }
}

class ErrorStateCard extends StatelessWidget {
  const ErrorStateCard(
      {super.key, required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => EmptyStateCard(
      icon: Icons.cloud_off_outlined,
      title: 'KEEL SERVER UNAVAILABLE',
      message: message,
      action: OutlinedButton.icon(
          onPressed: onRetry,
          icon: const Icon(Icons.refresh),
          label: const Text('RETRY')));
}
