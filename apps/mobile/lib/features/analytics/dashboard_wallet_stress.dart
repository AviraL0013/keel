import 'package:flutter/material.dart';

import 'analytics_contract.dart';
import 'dashboard_data.dart';
import 'dashboard_style.dart';
import 'dashboard_wallet_tools_data.dart';

class WalletStressContribution {
  const WalletStressContribution(this.position, this.change);
  final V1Position position;
  final AnalyticsDecimal change;
}

class WalletStress {
  const WalletStress(
      this.reason,
      this.marketId,
      this.currentMark,
      this.scenarioMark,
      this.total,
      this.longChange,
      this.shortChange,
      this.contributions);
  final String? reason;
  final int? marketId;
  final AnalyticsDecimal? currentMark,
      scenarioMark,
      total,
      longChange,
      shortChange;
  final List<WalletStressContribution> contributions;
  bool get available => reason == null;
}

int? largestWalletMarket(V1Envelope<V1WalletProfile>? snapshot) {
  if (snapshot == null ||
      walletSnapshotReason(snapshot, snapshot.data.address) != null) {
    return null;
  }
  final totals = <int, AnalyticsDecimal>{};
  for (final position in snapshot.data.positions) {
    final value = AnalyticsDecimal.parse(position.notional!);
    totals.update(position.marketId, (current) => current + value,
        ifAbsent: () => value);
  }
  int? largest;
  for (final id in totals.keys) {
    if (largest == null || totals[id]!.compareTo(totals[largest]!) > 0) {
      largest = id;
    }
  }
  return largest;
}

/// Exact linear mark sensitivity. This does not reconstruct venue settlement.
WalletStress calculateWalletStress(V1Envelope<V1WalletProfile>? snapshot,
    int? marketId, int shockBasisPoints) {
  final reason = snapshot == null
      ? 'Current wallet snapshot is unavailable.'
      : walletSnapshotReason(snapshot, snapshot.data.address);
  if (reason != null) {
    return WalletStress(
        reason, marketId, null, null, null, null, null, const []);
  }
  if (shockBasisPoints < -1000 ||
      shockBasisPoints > 1000 ||
      shockBasisPoints % 25 != 0) {
    return WalletStress('Choose a price move from −10% to +10%.', marketId,
        null, null, null, null, null, const []);
  }
  final positions = snapshot!.data.positions
      .where((position) => position.marketId == marketId)
      .toList();
  if (snapshot.data.positions.isEmpty) {
    return WalletStress('No current open positions.', marketId, null, null,
        null, null, null, const []);
  }
  if (positions.isEmpty) {
    return WalletStress('Select a current position market.', marketId, null,
        null, null, null, null, const []);
  }
  final mark = AnalyticsDecimal.parse(positions.first.markPrice!);
  if (positions
      .any((p) => AnalyticsDecimal.parse(p.markPrice!).compareTo(mark) != 0)) {
    return WalletStress('Current market marks disagree.', marketId, null, null,
        null, null, null, const []);
  }
  final zero = AnalyticsDecimal(BigInt.zero, 0);
  var total = zero, long = zero, short = zero;
  final contributions = <WalletStressContribution>[];
  for (final position in positions) {
    final sensitivity = decimalProduct(AnalyticsDecimal.parse(position.size),
        AnalyticsDecimal.parse(position.markPrice!));
    final change = AnalyticsDecimal(
        sensitivity.units *
            BigInt.from(
                position.side == 'long' ? shockBasisPoints : -shockBasisPoints),
        sensitivity.scale + 4);
    total = total + change;
    if (position.side == 'long') {
      long = long + change;
    } else {
      short = short + change;
    }
    contributions.add(WalletStressContribution(position, change));
  }
  contributions.sort((a, b) {
    final absoluteA = a.change.units.isNegative ? a.change.negative : a.change;
    final absoluteB = b.change.units.isNegative ? b.change.negative : b.change;
    final comparison = absoluteB.compareTo(absoluteA);
    return comparison != 0
        ? comparison
        : a.position.id.compareTo(b.position.id);
  });
  return WalletStress(
      null,
      marketId,
      mark,
      decimalProduct(
          mark, AnalyticsDecimal(BigInt.from(10000 + shockBasisPoints), 4)),
      total,
      long,
      short,
      contributions);
}

class WalletStressPanel extends StatefulWidget {
  const WalletStressPanel({super.key, required this.snapshot});
  final V1Envelope<V1WalletProfile>? snapshot;

  @override
  State<WalletStressPanel> createState() => _WalletStressPanelState();
}

class _WalletStressPanelState extends State<WalletStressPanel> {
  int? selectedMarket;
  int ticks = 0;
  bool expanded = false;

  @override
  void didUpdateWidget(WalletStressPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    final markets =
        widget.snapshot?.data.positions.map((p) => p.marketId).toSet() ?? {};
    if (selectedMarket != null && !markets.contains(selectedMarket)) {
      selectedMarket = null;
      ticks = 0;
      expanded = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = widget.snapshot;
    final verified = snapshot != null &&
        walletSnapshotReason(snapshot, snapshot.data.address) == null;
    final positions = verified ? snapshot.data.positions : <V1Position>[];
    final marketNames = <int, String>{};
    for (final position in positions) {
      marketNames.putIfAbsent(
          position.marketId, () => positionMarket(position));
    }
    final marketId = marketNames.containsKey(selectedMarket)
        ? selectedMarket
        : largestWalletMarket(snapshot);
    final result = calculateWalletStress(snapshot, marketId, ticks * 25);
    return DashboardCard(
      padding: 20,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Stress my wallet',
            style: TextStyle(
                color: AnalyticsPalette.text,
                fontSize: 17,
                fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        const Text('Hypothetical move in one current market',
            style: TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
        const SizedBox(height: 14),
        if (result.reason != null)
          Text(result.reason!,
              style: const TextStyle(color: AnalyticsPalette.muted))
        else ...[
          DropdownButtonFormField<int>(
            key: ValueKey('stress_market_$marketId'),
            initialValue: marketId,
            decoration: const InputDecoration(labelText: 'Market'),
            items: [
              for (final entry in marketNames.entries)
                DropdownMenuItem(
                    value: entry.key,
                    child: Text(entry.value, overflow: TextOverflow.ellipsis)),
            ],
            onChanged: (value) => setState(() {
              selectedMarket = value;
              expanded = false;
            }),
          ),
          const SizedBox(height: 12),
          Text('Price move: ${_shockLabel(ticks * 25)}',
              style: const TextStyle(
                  color: AnalyticsPalette.text, fontWeight: FontWeight.w600)),
          Slider(
            key: const ValueKey('stress_slider'),
            value: ticks.toDouble(),
            min: -40,
            max: 40,
            divisions: 80,
            label: _shockLabel(ticks * 25),
            onChanged: (value) => setState(() => ticks = value.round()),
          ),
          Wrap(spacing: 8, runSpacing: 4, children: [
            for (final basisPoints in [-500, 0, 500])
              OutlinedButton(
                onPressed: () => setState(() => ticks = basisPoints ~/ 25),
                child: Text(_shockLabel(basisPoints)),
              ),
          ]),
          const SizedBox(height: 12),
          const Text('Estimated PnL change',
              style: TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
          Text(signedMoney(result.total!),
              key: const ValueKey('stress_total'),
              style: const TextStyle(
                  color: AnalyticsPalette.text,
                  fontSize: 27,
                  fontWeight: FontWeight.w600)),
          const SizedBox(height: 5),
          Text(
              'Current mark ${result.currentMark} · scenario mark ${result.scenarioMark}',
              softWrap: true,
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
          const SizedBox(height: 8),
          Wrap(spacing: 14, runSpacing: 6, children: [
            Text('Longs ${signedMoney(result.longChange!)}'),
            Text('Shorts ${signedMoney(result.shortChange!)}'),
          ]),
          const SizedBox(height: 10),
          Text(
              result.contributions.first.change.units == BigInt.zero
                  ? 'Position contributions'
                  : 'Largest contributor first',
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
          for (final contribution in result.contributions
              .take(expanded ? result.contributions.length : 3))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(children: [
                Expanded(
                    child: Text(
                        '${contribution.position.side} · '
                        '${contribution.position.id}',
                        overflow: TextOverflow.ellipsis)),
                Text(signedMoney(contribution.change)),
              ]),
            ),
          if (result.contributions.length > 3)
            TextButton(
              onPressed: () => setState(() => expanded = !expanded),
              child: Text(expanded
                  ? 'Show less'
                  : 'Show ${result.contributions.length - 3} more'),
            ),
          const SizedBox(height: 8),
          Text('Only ${marketNames[marketId]} moves; other markets unchanged.',
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
        ],
        const SizedBox(height: 8),
        const Text(
            'Hypothetical price scenario. Position sizes held fixed. '
            'Excludes funding, fees, execution, and liquidation effects.',
            style: TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
      ]),
    );
  }
}

String _shockLabel(int basisPoints) {
  final absolute = basisPoints.abs();
  final whole = absolute ~/ 100;
  final fraction = (absolute % 100).toString().padLeft(2, '0');
  return '${basisPoints.isNegative ? '-' : basisPoints == 0 ? '' : '+'}'
      '$whole${fraction == '00' ? '' : '.$fraction'}%';
}
