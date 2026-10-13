import 'package:flutter/material.dart';

import 'analytics_contract.dart';
import 'dashboard_data.dart';
import 'dashboard_style.dart';
import 'dashboard_wallet_insights.dart';
import 'dashboard_wallet_tools_data.dart';

class WalletWatchEvent {
  const WalletWatchEvent(
      this.label, this.detail, this.from, this.through, this.block);
  final String label, detail;
  final DateTime from, through;
  final int block;
}

/// Session-only observations between consecutive verified Exchange snapshots.
class WalletWatchSession {
  WalletWatchSession(this.address);
  final String address;
  bool active = false;
  String status = 'Start live watch to compare current snapshots.';
  V1Envelope<V1WalletProfile>? baseline;
  V1Envelope<V1WalletProfile>? reference;
  V1Envelope<V1WalletProfile>? latest;
  final List<WalletWatchEvent> events = [];

  void start(V1Envelope<V1WalletProfile>? snapshot) {
    active = true;
    events.clear();
    baseline = null;
    reference = null;
    latest = null;
    status = 'Waiting for a verified baseline.';
    accept(snapshot);
  }

  void pause() {
    active = false;
    baseline = null;
    reference = null;
    status = 'Paused. Resume to establish a new baseline.';
  }

  void resume() {
    active = true;
    baseline = null;
    reference = null;
    status = 'Waiting for a new verified baseline.';
  }

  void gap(String reason) {
    if (!active) return;
    baseline = null;
    reference = null;
    status = '$reason Baseline will restart.';
  }

  void accept(V1Envelope<V1WalletProfile>? snapshot) {
    if (!active) return;
    final reason = walletSnapshotReason(snapshot, address);
    if (reason != null) {
      gap(reason);
      return;
    }
    final incoming = snapshot!;
    final previous = latest;
    if (previous != null &&
        baseline == null &&
        incoming.block! <= previous.block!) {
      status = 'Waiting for a newer verified snapshot to restart baseline.';
      return;
    }
    if (baseline == null) {
      baseline = incoming;
      reference = incoming;
      latest = incoming;
      status = 'Watching · no verified position changes observed yet.';
      return;
    }
    final earlier = baseline!;
    if (incoming.block! < earlier.block! ||
        incoming.asOf.isBefore(earlier.asOf)) {
      gap('Snapshot order could not be verified.');
      return;
    }
    if (incoming.block == earlier.block) {
      if (_snapshotIdentity(incoming) != _snapshotIdentity(earlier)) {
        gap('Snapshots conflict at the same block.');
      }
      return;
    }
    if (!_sameAccounts(earlier.data.accountIds, incoming.data.accountIds)) {
      events.clear();
      baseline = incoming;
      reference = incoming;
      latest = incoming;
      status = 'Linked accounts changed. Watch baseline reset.';
      return;
    }
    final oldPositions = {for (final p in earlier.data.positions) p.id: p};
    final newPositions = {for (final p in incoming.data.positions) p.id: p};
    final changes = <WalletWatchEvent>[];
    void add(String label, String detail) => changes.add(WalletWatchEvent(
        label, detail, earlier.asOf, incoming.asOf, incoming.block!));
    for (final id in {...oldPositions.keys, ...newPositions.keys}) {
      final before = oldPositions[id], after = newPositions[id];
      if (before == null) {
        add('Newly observed position',
            '${positionMarket(after!)} · ${after.side} · size ${after.size}');
      } else if (after == null) {
        add('Position no longer observed',
            '${positionMarket(before)} · last observed size ${before.size}');
      } else {
        if (before.side != after.side) {
          add('Observed side changed',
              '${positionMarket(after)} · ${before.side} to ${after.side}');
        }
        if (AnalyticsDecimal.parse(before.size)
                .compareTo(AnalyticsDecimal.parse(after.size)) !=
            0) {
          final direction = AnalyticsDecimal.parse(after.size)
                      .compareTo(AnalyticsDecimal.parse(before.size)) >
                  0
              ? 'increased'
              : 'decreased';
          add('Observed size $direction',
              '${positionMarket(after)} · ${before.size} to ${after.size}');
        }
      }
    }
    events.insertAll(0, changes.reversed);
    if (events.length > 20) events.removeRange(20, events.length);
    baseline = incoming;
    latest = incoming;
    status = changes.isEmpty
        ? 'Watching · no verified position changes observed in this snapshot.'
        : 'Watching · ${changes.length} new verified observation${changes.length == 1 ? '' : 's'}.';
  }
}

bool _sameAccounts(List<String> a, List<String> b) {
  if (a.length != b.length) return false;
  final first = [...a]..sort();
  final second = [...b]..sort();
  for (var i = 0; i < first.length; i++) {
    if (first[i] != second[i]) return false;
  }
  return true;
}

String _snapshotIdentity(V1Envelope<V1WalletProfile> snapshot) {
  final positions = [...snapshot.data.positions]
    ..sort((a, b) => a.id.compareTo(b.id));
  return '${[...snapshot.data.accountIds]..sort()}|'
      '${_canonicalDecimal(snapshot.data.margin.equity!)}|'
      '${positions.map((p) => [
            p.id,
            p.marketId,
            p.side,
            _canonicalDecimal(p.size),
            _canonicalDecimal(p.markPrice!),
            _canonicalDecimal(p.notional!)
          ].join(':')).join('|')}';
}

String _canonicalDecimal(String value) {
  final parsed = AnalyticsDecimal.parse(value);
  var units = parsed.units;
  var scale = parsed.scale;
  while (scale > 0 && units % BigInt.from(10) == BigInt.zero) {
    units ~/= BigInt.from(10);
    scale--;
  }
  return '$units:$scale';
}

class LiveWalletWatchPanel extends StatelessWidget {
  const LiveWalletWatchPanel(
      {super.key,
      required this.session,
      required this.onStart,
      required this.onPause,
      required this.onResume});
  final WalletWatchSession session;
  final VoidCallback onStart, onPause, onResume;

  @override
  Widget build(BuildContext context) {
    final latest = session.latest;
    final reference = session.reference;
    final insights =
        latest == null ? null : calculatePositionInsights(latest.data, null);
    final initialInsights = reference == null
        ? null
        : calculatePositionInsights(reference.data, null);
    return DashboardCard(
      padding: 20,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Live wallet watch',
            style: TextStyle(
                color: AnalyticsPalette.text,
                fontSize: 17,
                fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        const Text('Verified changes since watch started',
            style: TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
        const SizedBox(height: 12),
        Wrap(spacing: 8, runSpacing: 4, children: [
          if (!session.active && latest == null)
            OutlinedButton(
                onPressed: onStart, child: const Text('Start live watch'))
          else if (session.active)
            OutlinedButton(onPressed: onPause, child: const Text('Pause watch'))
          else
            OutlinedButton(
                onPressed: onResume, child: const Text('Resume watch')),
          if (latest != null)
            TextButton(onPressed: onStart, child: const Text('Restart watch')),
        ]),
        const SizedBox(height: 8),
        Text(session.status,
            key: const ValueKey('watch_status'),
            style:
                const TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
        if (latest != null) ...[
          const SizedBox(height: 8),
          Text(
              'Verified block ${latest.block} · ${latest.asOf.toUtc().toIso8601String()}',
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
          if (reference != null) ...[
            const SizedBox(height: 6),
            Text('Since verified block ${reference.block}',
                style: const TextStyle(
                    color: AnalyticsPalette.muted, fontSize: 11)),
            Text(
                'Marked gross ${analyticsMoney(_gross(reference))} to '
                '${analyticsMoney(_gross(latest))}',
                style: const TextStyle(
                    color: AnalyticsPalette.text, fontSize: 12)),
            Text(
                'Long share ${initialInsights?.longShare ?? '—'} to '
                '${insights?.longShare ?? '—'} · largest position '
                '${initialInsights?.largestShare ?? '—'} to '
                '${insights?.largestShare ?? '—'}',
                softWrap: true,
                style: const TextStyle(
                    color: AnalyticsPalette.text, fontSize: 12)),
            const Text('Marked exposure can change as prices move.',
                style: TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
          ],
        ],
        if (session.events.isNotEmpty) ...[
          const Divider(height: 20),
          for (final event in session.events.take(3)) _WatchEventRow(event),
          if (session.events.length > 3)
            ExpansionTile(
                title:
                    Text('${session.events.length - 3} earlier observations'),
                children: [
                  for (final event in session.events.skip(3))
                    _WatchEventRow(event)
                ]),
        ],
        const SizedBox(height: 8),
        const Text(
            'Observations compare current snapshots of accounts linked now. '
            'They do not establish trades or historical ownership.',
            style: TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
      ]),
    );
  }
}

AnalyticsDecimal _gross(V1Envelope<V1WalletProfile> snapshot) =>
    AnalyticsDecimal.parse(
        AnalyticsDecimal.sum(snapshot.data.positions.map((p) => p.notional)) ??
            '0');

class _WatchEventRow extends StatelessWidget {
  const _WatchEventRow(this.event);
  final WalletWatchEvent event;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(event.label,
              style: const TextStyle(
                  color: AnalyticsPalette.text, fontWeight: FontWeight.w600)),
          Text(event.detail,
              softWrap: true,
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
          Text(
              'Observed between ${event.from.toUtc().toIso8601String()} '
              'and ${event.through.toUtc().toIso8601String()} · block ${event.block}',
              softWrap: true,
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 10)),
        ]),
      );
}
