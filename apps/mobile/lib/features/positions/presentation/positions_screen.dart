import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/eyeler_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/eyeler_widgets.dart';
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
              padding: const EdgeInsets.fromLTRB(EyelerSpacing.md,
                  EyelerSpacing.sm, EyelerSpacing.md, EyelerSpacing.xl),
              children: [
                const Text('Your positions', style: EyelerTypography.display),
                const SizedBox(height: EyelerSpacing.xs),
                Text('Positions connected through Perpl.',
                    style: EyelerTypography.body.copyWith(
                        color: Theme.of(context).textTheme.bodyMedium?.color)),
                const SizedBox(height: EyelerSpacing.md),
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
                const SizedBox(height: EyelerSpacing.md),
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
    return EyelerPanel(
        tone: open ? EyelerColors.accent : EyelerColors.hold,
        child: Padding(
            padding: EdgeInsets.zero,
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                EyelerIconTile(
                    icon: position.market.toUpperCase().contains('BTC')
                        ? Icons.currency_bitcoin
                        : Icons.hexagon_outlined,
                    color: position.market.toUpperCase().contains('BTC')
                        ? EyelerColors.reduce
                        : EyelerColors.info,
                    size: 56),
                const SizedBox(width: EyelerSpacing.md),
                Expanded(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                      Text(position.market, style: EyelerTypography.title),
                      const SizedBox(height: EyelerSpacing.xs),
                      Text(
                          '${position.side} · ${position.leverage.toStringAsFixed(2)}x',
                          style: EyelerTypography.body.copyWith(
                              color: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.color)),
                    ])),
              ]),
              const SizedBox(height: EyelerSpacing.md),
              StatusPill(
                  label: position.status,
                  color: open ? EyelerColors.defend : EyelerColors.hold,
                  icon: open ? Icons.lock_open : Icons.lock_outline),
              const SizedBox(height: EyelerSpacing.lg),
              Text('Mark price',
                  style: EyelerTypography.body.copyWith(
                      color: Theme.of(context).textTheme.bodyMedium?.color)),
              Text(position.markPrice.toStringAsFixed(2),
                  style: EyelerTypography.display.copyWith(fontSize: 42)),
              Text(
                  'Unrealized P&L  ${position.pnl?.toStringAsFixed(2) ?? 'Unavailable'}',
                  style: EyelerTypography.section.copyWith(
                      color: position.pnl == null
                          ? EyelerColors.darkMuted
                          : position.pnl! >= 0
                              ? EyelerColors.defend
                              : EyelerColors.exit)),
              const SizedBox(height: EyelerSpacing.lg),
              if (distance != null && distance.isFinite) ...[
                EyelerPanel(
                    margin: EdgeInsets.zero,
                    padding: const EdgeInsets.all(EyelerSpacing.md),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Position health',
                              style: EyelerTypography.section),
                          const SizedBox(height: EyelerSpacing.xs),
                          Text('${distance.toStringAsFixed(2)}% to liquidation',
                              style: EyelerTypography.body),
                          const SizedBox(height: EyelerSpacing.sm),
                          LinearProgressIndicator(
                              value: (distance / 20).clamp(0.0, 1.0),
                              minHeight: 8,
                              borderRadius: BorderRadius.circular(20),
                              backgroundColor: EyelerColors.darkBorder,
                              color: distance <= 0
                                  ? EyelerColors.exit
                                  : distance < 5
                                      ? EyelerColors.reduce
                                      : EyelerColors.defend),
                        ])),
                const SizedBox(height: EyelerSpacing.md),
              ],
              Wrap(
                  spacing: EyelerSpacing.sm,
                  runSpacing: EyelerSpacing.sm,
                  children: [
                    _PositionFact('Size', _sizeLabel(position.size)),
                    _PositionFact('Margin', position.margin.toStringAsFixed(2)),
                    _PositionFact(
                        position.liquidationEstimated
                            ? 'Est. liquidation'
                            : 'Liquidation',
                        position.liquidationPrice.toStringAsFixed(2)),
                  ]),
              const SizedBox(height: EyelerSpacing.md),
              Text('Account ${position.accountId}',
                  style: EyelerTypography.body.copyWith(
                      color: Theme.of(context).textTheme.bodyMedium?.color)),
              ExpansionTile(
                  title: const Text('Market details'),
                  tilePadding: EdgeInsets.zero,
                  children: [
                    _PositionMetricGrid(position: position),
                    const SizedBox(height: EyelerSpacing.md),
                    TelemetryFreshness(freshness: position.freshness),
                  ]),
              if (open) ...[
                const SizedBox(height: EyelerSpacing.lg),
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
        padding: const EdgeInsets.all(EyelerSpacing.sm),
        decoration: BoxDecoration(
            color: Theme.of(context).brightness == Brightness.dark
                ? EyelerColors.darkCanvas.withValues(alpha: .55)
                : EyelerColors.lightBackground,
            border: Border.all(
                color: Theme.of(context).brightness == Brightness.dark
                    ? EyelerColors.darkBorder
                    : EyelerColors.lightBorder),
            borderRadius: BorderRadius.circular(14)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label,
              style: EyelerTypography.body.copyWith(
                  fontSize: 11,
                  color: Theme.of(context).textTheme.bodyMedium?.color)),
          Text(value, style: EyelerTypography.section),
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
          mainAxisSpacing: EyelerSpacing.md,
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
    return EyelerPanel(
        child: Padding(
            padding: EdgeInsets.zero,
            child: Row(children: [
              EyelerIconTile(
                  icon: valid ? Icons.link : Icons.link_off,
                  color: valid ? EyelerColors.defend : EyelerColors.reduce),
              const SizedBox(width: EyelerSpacing.md),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(valid ? 'Perpl Connected' : 'Perpl $status',
                        style: EyelerTypography.section),
                    Text(
                        '${environment?.toUpperCase() ?? 'SERVER-SIDE'}${accountId == null ? '' : ' / ACCOUNT $accountId'}',
                        style: EyelerTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color))
                  ])),
              if (valid)
                const StatusPill(label: 'Connected', color: EyelerColors.info),
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
            style: EyelerTypography.label.copyWith(
                color: Theme.of(context).textTheme.bodyMedium?.color)),
        const SizedBox(height: 4),
        Text(value, style: EyelerTypography.metric.copyWith(fontSize: 16))
      ]);
}
