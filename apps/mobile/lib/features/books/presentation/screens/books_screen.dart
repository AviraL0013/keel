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

class BooksScreen extends ConsumerWidget {
  const BooksScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final books = ref.watch(booksProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('KEEL'), actions: [
        IconButton(
            onPressed: () => ref.invalidate(booksProvider),
            icon: const Icon(Icons.refresh))
      ]),
      body: books.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(
            message: friendlyError(error),
            onRetry: () => ref.invalidate(booksProvider)),
        data: (items) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(booksProvider),
          child: ListView(
              padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm,
                  KeelSpacing.md, KeelSpacing.xl),
              children: [
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
    final telemetry = ref.watch(bookTelemetryProvider(book.id));
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(KeelRadii.card),
        onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => BookDetailScreen(book: book))),
        child: Padding(
            padding: const EdgeInsets.all(KeelSpacing.lg),
            child: telemetry.when(
              loading: () => const LinearProgressIndicator(),
              error: (error, _) => Text(friendlyError(error)),
              data: (state) {
                final visual = KeelRiskVisual.forState(state.riskState);
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(book.market,
                                      style: KeelTypography.title),
                                  const SizedBox(height: KeelSpacing.xs),
                                  Text('${book.side} / ${book.stance}',
                                      style: KeelTypography.body.copyWith(
                                          color: Theme.of(context)
                                              .textTheme
                                              .bodyMedium
                                              ?.color))
                                ]),
                            StatusPill(
                                label: visual.label,
                                color: visual.color,
                                icon: visual.icon),
                          ]),
                      const SizedBox(height: KeelSpacing.lg),
                      Text(visual.description,
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
                        Expanded(
                            child: Align(
                                alignment: Alignment.centerRight,
                                child: TelemetryFreshness(
                                    freshness: state.freshness)))
                      ]),
                      const SizedBox(height: KeelSpacing.md),
                      LinearProgressIndicator(
                          value: state.freshnessMs == null
                              ? null
                              : state.stale
                                  ? .18
                                  : .82,
                          minHeight: 6,
                          color: state.stale
                              ? KeelColors.reduce
                              : KeelColors.defend,
                          backgroundColor: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: .1)),
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
