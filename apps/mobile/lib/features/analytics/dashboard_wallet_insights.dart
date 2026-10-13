import 'package:flutter/material.dart';

import 'analytics_contract.dart';
import 'dashboard_data.dart';
import 'dashboard_style.dart';
import 'dashboard_wallet.dart' show DashboardWalletActivity;

/// Values derived only from the current wallet profile and its activity response.
class PositionInsights {
  const PositionInsights({
    required this.positionReason,
    required this.longShare,
    required this.shortShare,
    required this.largestShare,
    required this.largestMarket,
    required this.activeDays,
    required this.verifiedDays,
    required this.activityReason,
  });

  final String? positionReason;
  final String? longShare, shortShare, largestShare, largestMarket;
  final int? activeDays;
  final int verifiedDays;
  final String? activityReason;

  bool get hasPositionShares => positionReason == null;
}

/// Pure calculation. A non-null equity is the profile endpoint's signal that
/// position enumeration and marks were verified at the snapshot block.
PositionInsights calculatePositionInsights(
  V1WalletProfile? profile,
  DashboardWalletActivity? activity,
) {
  String? positionReason;
  String? longShare, shortShare, largestShare, largestMarket;

  if (profile == null) {
    positionReason = 'Verified current positions are unavailable.';
  } else if (profile.margin.equity == null) {
    positionReason = 'Complete position enumeration or marks are unavailable.';
  } else if (profile.positions.isEmpty) {
    positionReason = 'No current open positions.';
  } else if (profile.positions.any((position) {
    if (position.notional == null || position.markPrice == null) return true;
    return AnalyticsDecimal.parse(position.notional!).units.isNegative ||
        AnalyticsDecimal.parse(position.markPrice!).units <= BigInt.zero;
  })) {
    positionReason = 'Position marks are unavailable.';
  } else {
    final gross = AnalyticsDecimal.parse(
      AnalyticsDecimal.sum(profile.positions.map((p) => p.notional))!,
    );
    if (gross.units == BigInt.zero) {
      positionReason = 'Marked gross notional is zero.';
    } else {
      final long = AnalyticsDecimal.parse(
        AnalyticsDecimal.sum(
              profile.positions
                  .where((p) => p.side == 'long')
                  .map((p) => p.notional),
            ) ??
            '0',
      );
      final longTenths = _shareTenths(long, gross);
      longShare = _percent(longTenths);
      shortShare = _percent(BigInt.from(1000) - longTenths);
      final largest = profile.positions.reduce(
        (a, b) => AnalyticsDecimal.parse(a.notional!)
                    .compareTo(AnalyticsDecimal.parse(b.notional!)) >=
                0
            ? a
            : b,
      );
      largestShare = _percent(
        _shareTenths(AnalyticsDecimal.parse(largest.notional!), gross),
      );
      largestMarket = largest.symbol.trim().isEmpty
          ? 'Market ${largest.marketId}'
          : '${largest.symbol} · market ${largest.marketId}';
    }
  }

  final verifiedDays = activity?.verifiedDays ?? 0;
  final activeDays = activity?.activeDays;
  final activityValid = activity != null &&
      (profile == null ||
          activity.address.toLowerCase() == profile.address.toLowerCase()) &&
      verifiedDays >= 0 &&
      verifiedDays <= 30 &&
      activeDays != null &&
      activeDays >= 0 &&
      activeDays <= verifiedDays;
  return PositionInsights(
    positionReason: positionReason,
    longShare: longShare,
    shortShare: shortShare,
    largestShare: largestShare,
    largestMarket: largestMarket,
    activeDays: activityValid ? activeDays : null,
    verifiedDays: verifiedDays.clamp(0, 30),
    activityReason: activityValid ? null : 'Verified activity is unavailable.',
  );
}

BigInt _shareTenths(AnalyticsDecimal part, AnalyticsDecimal gross) {
  final scale = part.scale > gross.scale ? part.scale : gross.scale;
  final numerator = part.units * BigInt.from(10).pow(scale - part.scale);
  final denominator = gross.units * BigInt.from(10).pow(scale - gross.scale);
  return (numerator * BigInt.from(1000) + denominator ~/ BigInt.two) ~/
      denominator;
}

String _percent(BigInt tenths) =>
    '${tenths ~/ BigInt.from(10)}.${tenths % BigInt.from(10)}%';

/// Compact card for the public wallet page. Pass parsed endpoint data directly.
class PositionInsightsPanel extends StatelessWidget {
  const PositionInsightsPanel({
    super.key,
    required this.profile,
    required this.activity,
  });

  final V1WalletProfile? profile;
  final DashboardWalletActivity? activity;

  @override
  Widget build(BuildContext context) {
    final insight = calculatePositionInsights(profile, activity);
    return DashboardCard(
      padding: 20,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Position insights',
            style: TextStyle(
              color: AnalyticsPalette.text,
              fontSize: 17,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 5),
          const Text(
            'Current verified positions · marked gross notional',
            style: TextStyle(color: AnalyticsPalette.muted, fontSize: 12),
          ),
          const SizedBox(height: 16),
          LayoutBuilder(
            builder: (context, constraints) {
              final cards = <Widget>[
                if (!insight.hasPositionShares)
                  _InsightValue(
                    label: 'Current positions',
                    value: null,
                    reason: insight.positionReason,
                  )
                else ...[
                  _InsightValue(
                    label: 'Directional exposure',
                    value:
                        '${insight.longShare} long · ${insight.shortShare} short',
                  ),
                  _InsightValue(
                    label: 'Largest position',
                    value: '${insight.largestShare} · ${insight.largestMarket}',
                  ),
                ],
                _InsightValue(
                  label: 'Activity',
                  value: insight.activeDays == null
                      ? null
                      : '${insight.activeDays}/${insight.verifiedDays} active days',
                  reason: insight.activityReason,
                  detail: activity == null
                      ? null
                      : '${insight.verifiedDays}/30 verified days',
                ),
              ];
              if (constraints.maxWidth < 700) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var i = 0; i < cards.length; i++) ...[
                      if (i > 0) const SizedBox(height: 12),
                      cards[i],
                    ],
                  ],
                );
              }
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (var i = 0; i < cards.length; i++) ...[
                    if (i > 0) const SizedBox(width: 12),
                    Expanded(child: cards[i]),
                  ],
                ],
              );
            },
          ),
          const SizedBox(height: 14),
          const Text(
            'Accounts currently linked to this wallet.',
            style: TextStyle(color: AnalyticsPalette.muted, fontSize: 11),
          ),
          const Text(
            'Activity covers the last 30 completed UTC days.',
            style: TextStyle(color: AnalyticsPalette.muted, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

class _InsightValue extends StatelessWidget {
  const _InsightValue({
    required this.label,
    required this.value,
    this.reason,
    this.detail,
  });

  final String label;
  final String? value, reason, detail;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: AnalyticsPalette.elevated,
          border: Border.all(color: AnalyticsPalette.border),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 12),
            ),
            const SizedBox(height: 6),
            Text(
              value ?? reason ?? 'Unavailable',
              style: TextStyle(
                color: value == null
                    ? AnalyticsPalette.muted
                    : AnalyticsPalette.text,
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
            if (detail != null) ...[
              const SizedBox(height: 4),
              Text(
                detail!,
                style: const TextStyle(
                    color: AnalyticsPalette.muted, fontSize: 11),
              ),
            ],
          ],
        ),
      );
}
