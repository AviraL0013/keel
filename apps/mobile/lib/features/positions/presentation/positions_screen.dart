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
      appBar: AppBar(title: const Text('Positions'), actions: [
        IconButton(
            onPressed: () {
              ref.invalidate(positionsProvider);
              ref.invalidate(perplConnectionProvider);
            },
            icon: const Icon(Icons.refresh))
      ]),
      body: positions.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(
            message: friendlyError(error),
            onRetry: () => ref.invalidate(positionsProvider)),
        data: (items) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(positionsProvider);
            ref.invalidate(perplConnectionProvider);
          },
          child: ListView(
              padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm,
                  KeelSpacing.md, KeelSpacing.xl),
              children: [
                const Text('Your positions', style: KeelTypography.display),
                const SizedBox(height: KeelSpacing.xs),
                Text('Positions connected through Perpl.',
                    style: KeelTypography.body.copyWith(
                        color: Theme.of(context).textTheme.bodyMedium?.color)),
                const SizedBox(height: KeelSpacing.md),
                // Successful position retrieval is authoritative proof that the
                // configured server-side Perpl stream is usable. The validate
                // endpoint may be unavailable independently of read access.
                if (items.isNotEmpty)
                  _ConnectionCard(accountId: items.first.accountId)
                else
                  connection.when(
                    data: (value) => _ConnectionCard(
                        accountId: value.accountId,
                        status: value.status,
                        environment: value.environment,
                        onRetry: value.status == 'VALID'
                            ? null
                            : () => ref.invalidate(perplConnectionProvider)),
                    loading: () => const LinearProgressIndicator(),
                    error: (_, __) => const EmptyStateCard(
                        icon: Icons.link_off,
                        title: 'PERPL UNAVAILABLE',
                        message:
                            'No positions returned. Retry when the server-side venue connection is available.'),
                  ),
                const SizedBox(height: KeelSpacing.md),
                if (items.isEmpty)
                  const EmptyStateCard(
                      icon: Icons.layers_clear_outlined,
                      title: 'NO ACTIVE POSITIONS',
                      message:
                          'Connect a Perpl account to discover positions.'),
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
    final distance = position.markPrice <= 0
        ? null
        : position.side == 'LONG'
            ? (position.markPrice - position.liquidationPrice) /
                position.markPrice *
                100
            : (position.liquidationPrice - position.markPrice) /
                position.markPrice *
                100;
    return KeelPanel(
        tone: open ? KeelColors.accent : KeelColors.hold,
        child: Padding(
            padding: EdgeInsets.zero,
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                KeelIconTile(
                    icon: position.market.toUpperCase().contains('BTC')
                        ? Icons.currency_bitcoin
                        : Icons.hexagon_outlined,
                    color: position.market.toUpperCase().contains('BTC')
                        ? KeelColors.reduce
                        : KeelColors.info,
                    size: 56),
                const SizedBox(width: KeelSpacing.md),
                Expanded(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                      Text(position.market, style: KeelTypography.title),
                      const SizedBox(height: KeelSpacing.xs),
                      Text(
                          '${position.side} · ${position.leverage.toStringAsFixed(2)}x',
                          style: KeelTypography.body.copyWith(
                              color: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.color)),
                    ])),
              ]),
              const SizedBox(height: KeelSpacing.md),
              StatusPill(
                  label: position.status,
                  color: open ? KeelColors.defend : KeelColors.hold,
                  icon: open ? Icons.lock_open : Icons.lock_outline),
              const SizedBox(height: KeelSpacing.lg),
              Text('Mark price',
                  style: KeelTypography.body.copyWith(
                      color: Theme.of(context).textTheme.bodyMedium?.color)),
              Text(position.markPrice.toStringAsFixed(2),
                  style: KeelTypography.display.copyWith(fontSize: 42)),
              Text(
                  'Unrealized P&L  ${position.pnl?.toStringAsFixed(2) ?? 'Unavailable'}',
                  style: KeelTypography.section.copyWith(
                      color: position.pnl == null
                          ? KeelColors.darkMuted
                          : position.pnl! >= 0
                              ? KeelColors.defend
                              : KeelColors.exit)),
              const SizedBox(height: KeelSpacing.lg),
              if (distance != null && distance.isFinite) ...[
                KeelPanel(
                    margin: EdgeInsets.zero,
                    padding: const EdgeInsets.all(KeelSpacing.md),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Position health',
                              style: KeelTypography.section),
                          const SizedBox(height: KeelSpacing.xs),
                          Text('${distance.toStringAsFixed(2)}% to liquidation',
                              style: KeelTypography.body),
                          const SizedBox(height: KeelSpacing.sm),
                          LinearProgressIndicator(
                              value: (distance / 20).clamp(0.0, 1.0),
                              minHeight: 8,
                              borderRadius: BorderRadius.circular(20),
                              backgroundColor: KeelColors.darkBorder,
                              color: distance <= 0
                                  ? KeelColors.exit
                                  : distance < 5
                                      ? KeelColors.reduce
                                      : KeelColors.defend),
                        ])),
                const SizedBox(height: KeelSpacing.md),
              ],
              Wrap(
                  spacing: KeelSpacing.sm,
                  runSpacing: KeelSpacing.sm,
                  children: [
                    _PositionFact('Size', _sizeLabel(position.size)),
                    _PositionFact('Margin', position.margin.toStringAsFixed(2)),
                    _PositionFact(
                        position.liquidationEstimated
                            ? 'Est. liquidation'
                            : 'Liquidation',
                        position.liquidationPrice.toStringAsFixed(2)),
                  ]),
              const SizedBox(height: KeelSpacing.md),
              Text('Account ${position.accountId}',
                  style: KeelTypography.body.copyWith(
                      color: Theme.of(context).textTheme.bodyMedium?.color)),
              ExpansionTile(
                  title: const Text('Market details'),
                  tilePadding: EdgeInsets.zero,
                  children: [
                    _PositionMetricGrid(position: position),
                    const SizedBox(height: KeelSpacing.md),
                    TelemetryFreshness(freshness: position.freshness),
                  ]),
              if (open) ...[
                const SizedBox(height: KeelSpacing.lg),
                SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                        onPressed: () {
                          Navigator.of(context).push(MaterialPageRoute(
                              builder: (_) =>
                                  CreateBookScreen(position: position)));
                        },
                        icon: const Icon(Icons.shield_outlined),
                        label: const Text('CREATE BOOK'))),
              ],
            ])));
  }

  String _sizeLabel(double value) => value.abs() < 1
      ? value
          .toStringAsFixed(6)
          .replaceFirst(RegExp(r'0+$'), '')
          .replaceFirst(RegExp(r'\.$'), '')
      : value.toStringAsFixed(2);
}

class _PositionFact extends StatelessWidget {
  const _PositionFact(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(KeelSpacing.sm),
        decoration: BoxDecoration(
            color: Theme.of(context).brightness == Brightness.dark
                ? KeelColors.darkCanvas.withValues(alpha: .55)
                : KeelColors.lightBackground,
            border: Border.all(
                color: Theme.of(context).brightness == Brightness.dark
                    ? KeelColors.darkBorder
                    : KeelColors.lightBorder),
            borderRadius: BorderRadius.circular(14)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label,
              style: KeelTypography.body.copyWith(
                  fontSize: 11,
                  color: Theme.of(context).textTheme.bodyMedium?.color)),
          Text(value, style: KeelTypography.section),
        ]),
      );
}

class _PositionMetricGrid extends StatelessWidget {
  const _PositionMetricGrid({required this.position});
  final Position position;
  @override
  Widget build(BuildContext context) => GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          childAspectRatio: 2.5,
          mainAxisSpacing: KeelSpacing.md,
          children: [
            _Metric('SIZE', _size(position.size)),
            _Metric('ENTRY', _number(position.entryPrice)),
            _Metric('MARK', _number(position.markPrice)),
            _Metric('PNL', _number(position.pnl)),
            _Metric(
                position.liquidationEstimated
                    ? 'EST. LIQUIDATION'
                    : 'LIQUIDATION',
                _number(position.liquidationPrice)),
            _Metric('MARGIN', _number(position.margin)),
            _Metric('BID', _number(position.bid)),
            _Metric('ASK', _number(position.ask)),
            _Metric('FUNDING', _number(position.fundingRate)),
            _Metric('DEPTH', _number(position.depthNotional))
          ]);
  String _number(double? value) =>
      value == null ? 'Unavailable' : value.toStringAsFixed(2);
  String _size(double? value) {
    if (value == null) return 'Unavailable';
    if (value.abs() < 1) {
      return value
          .toStringAsFixed(6)
          .replaceFirst(RegExp(r'0+$'), '')
          .replaceFirst(RegExp(r'\\.$'), '');
    }
    return value.toStringAsFixed(2);
  }
}

class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard(
      {required this.accountId,
      this.status = 'VALID',
      this.environment = 'testnet',
      this.onRetry});
  final int? accountId;
  final String status;
  final String? environment;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final valid = status == 'VALID';
    return KeelPanel(
        child: Padding(
            padding: EdgeInsets.zero,
            child: Row(children: [
              KeelIconTile(
                  icon: valid ? Icons.link : Icons.link_off,
                  color: valid ? KeelColors.defend : KeelColors.reduce),
              const SizedBox(width: KeelSpacing.md),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(valid ? 'Perpl Connected' : 'Perpl $status',
                        style: KeelTypography.section),
                    Text(
                        '${environment?.toUpperCase() ?? 'SERVER-SIDE'}${accountId == null ? '' : ' / ACCOUNT $accountId'}',
                        style: KeelTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color))
                  ])),
              if (valid)
                const StatusPill(label: 'Connected', color: KeelColors.info),
              if (onRetry != null)
                TextButton(onPressed: onRetry, child: const Text('RETRY'))
            ])));
  }
}

class _Metric extends StatelessWidget {
  const _Metric(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label,
            style: KeelTypography.label.copyWith(
                color: Theme.of(context).textTheme.bodyMedium?.color)),
        const SizedBox(height: 4),
        Text(value, style: KeelTypography.metric.copyWith(fontSize: 16))
      ]);
}
