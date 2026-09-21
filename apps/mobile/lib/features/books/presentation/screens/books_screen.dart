import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../../data/books_repository.dart';
import '../../domain/book.dart';
import '../../../positions/domain/position.dart';
import '../../../positions/presentation/positions_screen.dart';
import 'book_detail_screen.dart';
import 'create_book_screen.dart';
import '../widgets/live_sync_status.dart';

class BooksScreen extends ConsumerStatefulWidget {
  const BooksScreen({super.key});
  @override
  ConsumerState<BooksScreen> createState() => _BooksScreenState();
}

class _BooksScreenState extends ConsumerState<BooksScreen> {
  bool _syncing = false;
  bool _updated = false;
  String? _syncError;
  Timer? _updatedTimer;

  @override
  void dispose() {
    _updatedTimer?.cancel();
    super.dispose();
  }

  Future<void> _resync() async {
    if (_syncing) return;
    _updatedTimer?.cancel();
    setState(() { _syncing = true; _updated = false; _syncError = null; });
    try {
      final items = await ref.refresh(booksProvider.future);
      await Future.wait(items.map((book) {
        return ref.read(bookDashboardProvider(book.id).notifier).refreshNow();
      }));
      if (!mounted) return;
      setState(() { _syncing = false; _updated = true; });
      _updatedTimer = Timer(const Duration(seconds: 2), () {
        if (mounted) setState(() => _updated = false);
      });
    } catch (error) {
      if (mounted) setState(() { _syncing = false; _syncError = friendlyError(error); });
    }
  }

  @override
  Widget build(BuildContext context) {
    final books = ref.watch(booksProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('KEEL'), actions: [
        SizedBox(width: 104, child: Center(child: Text(
            _syncing ? 'SYNCING' : _updated ? 'UPDATED' : _syncError != null ? 'RESYNC FAILED' : '',
            style: KeelTypography.label))),
        IconButton(
            tooltip: 'Resync Books',
            onPressed: _syncing ? null : _resync,
            icon: const Icon(Icons.refresh))
      ]),
      body: books.when(
        skipLoadingOnReload: true,
        skipError: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(
            message: friendlyError(error),
            onRetry: () => ref.invalidate(booksProvider)),
        data: (items) => RefreshIndicator(
          onRefresh: _resync,
          child: ListView(
              padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm,
                  KeelSpacing.md, KeelSpacing.xl),
              children: [
                if (_syncError != null) Text(_syncError!, style: KeelTypography.body),
                Text('Good morning',
                    style: KeelTypography.body.copyWith(
                        color: Theme.of(context).textTheme.bodyMedium?.color)),
                const SizedBox(height: KeelSpacing.xs),
                const Text('Your Books', style: KeelTypography.display),
                const SizedBox(height: KeelSpacing.xs),
                Text(
                    '${items.length} protected position${items.length == 1 ? '' : 's'}',
                    style: KeelTypography.body.copyWith(
                        color: Theme.of(context).textTheme.bodyMedium?.color)),
                const SizedBox(height: KeelSpacing.lg),
                if (items.isEmpty)
                  EmptyStateCard(
                      icon: Icons.shield_outlined,
                      title: 'PROTECT A POSITION',
                      message:
                          'Create your first Book from an active Perpl position.',
                      action: SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                              onPressed: () => Navigator.of(context).push(
                                  MaterialPageRoute(
                                      builder: (_) => const PositionsScreen())),
                              icon: const Icon(Icons.arrow_forward),
                              label: const Text('VIEW POSITIONS')))),
                ...items.map((book) => Padding(
                    key: ValueKey('book-card-${book.id}'),
                    padding: const EdgeInsets.only(bottom: KeelSpacing.md),
                    child: _BookCard(book: book))),
              ]),
        ),
      ),
    );
  }
}

class _BookCard extends ConsumerWidget {
  const _BookCard({required this.book});
  final Book book;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final telemetry = ref.watch(bookDashboardProvider(book.id));
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(KeelRadii.card),
        onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => BookDetailScreen(book: book))),
        child: Padding(
            padding: const EdgeInsets.all(KeelSpacing.lg),
            child: telemetry.when(
              skipLoadingOnReload: true,
              skipError: true,
              loading: () => const LinearProgressIndicator(),
              error: (error, _) => Text(friendlyError(error)),
              data: (dashboard) {
                final state = dashboard.telemetry;
                final currentBook = dashboard.book;
                final visual = KeelRiskVisual.forState(state.riskState);
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Expanded(child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(currentBook.market,
                                      style: KeelTypography.title),
                                  const SizedBox(height: KeelSpacing.xs),
                                  Text('${currentBook.side} / ${currentBook.stance}',
                                      style: KeelTypography.body.copyWith(
                                          color: Theme.of(context)
                                              .textTheme
                                              .bodyMedium
                                              ?.color))
                                ])),
                            const SizedBox(width: KeelSpacing.sm),
                            StatusPill(
                                label: visual.label,
                                color: visual.color,
                                icon: visual.icon),
                          ]),
                      const SizedBox(height: KeelSpacing.lg),
                      Text(state.riskReason ?? (state.reasons.isNotEmpty ? state.reasons.join(' ') : visual.description),
                          style: KeelTypography.body.copyWith(
                              color: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.color)),
                      const SizedBox(height: KeelSpacing.lg),
                      Row(children: [
                        _Metric(label: 'PNL', value: _number(state.pnl)),
                        _Metric(
                            label: 'RESERVE',
                            value: _number(state.reserveAvailable)),
                      ]),
                      const SizedBox(height: KeelSpacing.md),
                      TelemetryFreshness(freshness: telemetry.hasError ? null : state.freshness),
                      const SizedBox(height: KeelSpacing.md),
                      Wrap(spacing: KeelSpacing.sm, runSpacing: KeelSpacing.xs, children: [
                        Text('BOOK ${currentBook.status}', style: KeelTypography.label),
                        Text(currentBook.automationEnabled ? 'AUTOMATION ON' : 'AUTOMATION OFF', style: KeelTypography.label),
                        Text(state.executionState ?? 'UNKNOWN', style: KeelTypography.label),
                      ]),
                      LiveSyncStatus(value: telemetry),
                    ]);
              },
            )),
      ),
    );
  }

  String _number(double? value) =>
      value == null ? 'Unavailable' : value.toStringAsFixed(2);
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value});
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Expanded(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label,
            style: KeelTypography.label.copyWith(
                color: Theme.of(context).textTheme.bodyMedium?.color)),
        const SizedBox(height: 4),
        Text(value, style: KeelTypography.metric.copyWith(fontSize: 16))
      ]));
}

class CreateBookEntry extends StatelessWidget {
  const CreateBookEntry({super.key, required this.position});
  final Position position;
  @override
  Widget build(BuildContext context) => CreateBookScreen(position: position);
}
