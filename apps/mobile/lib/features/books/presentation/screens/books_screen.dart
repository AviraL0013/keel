import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/eyeler_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/eyeler_widgets.dart';
import '../../data/books_repository.dart';
import '../../domain/book.dart';
import '../../../positions/domain/position.dart';
import '../../../positions/presentation/positions_screen.dart';
import 'book_detail_screen.dart';
import 'create_book_screen.dart';
import '../widgets/book_summary.dart';
import '../widgets/live_sync_status.dart';

enum _BookListTab { current, history }

enum _BookFilter { all, active, safetyPaused, paused }

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
  Timer? _listTimer;
  _BookListTab _tab = _BookListTab.current;
  _BookFilter _statusFilter = _BookFilter.all;
  String? _marketFilter;

  @override
  void initState() {
    super.initState();
    _listTimer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted && !_syncing) ref.invalidate(booksProvider);
    });
  }

  @override
  void dispose() {
    _updatedTimer?.cancel();
    _listTimer?.cancel();
    super.dispose();
  }

  List<Book> _visibleBooks(List<Book> items) {
    final current = _tab == _BookListTab.current;
    final inTab = items.where((book) => (book.status == 'CLOSED') != current);
    final inMarket = inTab
        .where((book) => _marketFilter == null || book.market == _marketFilter);
    final filtered = inMarket
        .where((book) =>
            !current ||
            switch (_statusFilter) {
              _BookFilter.all => true,
              _BookFilter.active => book.status == 'ACTIVE',
              _BookFilter.safetyPaused => book.status == 'SAFE_MODE',
              _BookFilter.paused => book.status == 'PAUSED',
            })
        .toList();
    if (!current) return filtered;
    // Safety-paused Books stay first; original order remains within each group.
    return [
      ...filtered.where((book) => book.status == 'SAFE_MODE'),
      ...filtered.where((book) => book.status == 'PAUSED'),
      ...filtered.where(
          (book) => book.status != 'SAFE_MODE' && book.status != 'PAUSED'),
    ];
  }

  Future<void> _showFilters(List<Book> items) async {
    var market = _marketFilter;
    var status = _statusFilter;
    final markets = items.map((book) => book.market).toSet().toList()..sort();
    await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (sheetContext) => StatefulBuilder(
            builder: (sheetContext, update) => SafeArea(
                child: ConstrainedBox(
                    constraints: BoxConstraints(
                        maxHeight: MediaQuery.sizeOf(sheetContext).height * .8),
                    child: SingleChildScrollView(
                        child: Padding(
                            padding: const EdgeInsets.all(EyelerSpacing.lg),
                            child: Column(
                                mainAxisSize: MainAxisSize.min,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text('Filter Books',
                                      style: EyelerTypography.title),
                                  const SizedBox(height: EyelerSpacing.md),
                                  const Text('Market',
                                      style: EyelerTypography.label),
                                  const SizedBox(height: EyelerSpacing.sm),
                                  Wrap(
                                      spacing: EyelerSpacing.sm,
                                      runSpacing: EyelerSpacing.xs,
                                      children: [
                                        ChoiceChip(
                                            label: const Text('All'),
                                            selected: market == null,
                                            onSelected: (_) =>
                                                update(() => market = null)),
                                        for (final item in markets)
                                          ChoiceChip(
                                              label: Text(item),
                                              selected: market == item,
                                              onSelected: (_) =>
                                                  update(() => market = item)),
                                      ]),
                                  if (_tab == _BookListTab.current) ...[
                                    const SizedBox(height: EyelerSpacing.lg),
                                    const Text('Status',
                                        style: EyelerTypography.label),
                                    const SizedBox(height: EyelerSpacing.sm),
                                    Wrap(
                                        spacing: EyelerSpacing.sm,
                                        runSpacing: EyelerSpacing.xs,
                                        children: [
                                          for (final option
                                              in _BookFilter.values)
                                            ChoiceChip(
                                                label: Text(switch (option) {
                                                  _BookFilter.all => 'All',
                                                  _BookFilter.active =>
                                                    'Active',
                                                  _BookFilter.safetyPaused =>
                                                    'Safety paused',
                                                  _BookFilter.paused =>
                                                    'Paused',
                                                }),
                                                selected: status == option,
                                                onSelected: (_) => update(
                                                    () => status = option)),
                                        ]),
                                  ],
                                  const SizedBox(height: EyelerSpacing.lg),
                                  SizedBox(
                                      width: double.infinity,
                                      child: FilledButton(
                                          onPressed: () {
                                            setState(() {
                                              _marketFilter = market;
                                              _statusFilter = status;
                                            });
                                            Navigator.pop(sheetContext);
                                          },
                                          child: const Text('SHOW BOOKS'))),
                                ])))))));
  }

  Future<void> _resync() async {
    if (_syncing) return;
    _updatedTimer?.cancel();
    setState(() {
      _syncing = true;
      _updated = false;
      _syncError = null;
    });
    try {
      final items = await ref.refresh(booksProvider.future);
      await Future.wait(items.map((book) {
        return ref.read(bookDashboardProvider(book.id).notifier).refreshNow();
      }));
      if (!mounted) return;
      setState(() {
        _syncing = false;
        _updated = true;
      });
      _updatedTimer = Timer(const Duration(seconds: 2), () {
        if (mounted) setState(() => _updated = false);
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _syncing = false;
          _syncError = friendlyError(error);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final books = ref.watch(booksProvider);
    return Scaffold(
      appBar: AppBar(
          titleSpacing: EyelerSpacing.md,
          title: Row(children: [
            Container(
                width: 34,
                height: 34,
                padding: const EdgeInsets.all(7),
                decoration: BoxDecoration(
                    color: EyelerColors.darkText,
                    borderRadius: BorderRadius.circular(12)),
                child: Image.asset('assets/branding/eyeler-eye.png')),
            const SizedBox(width: 10),
            Text('EYELER',
                style: EyelerTypography.section.copyWith(
                    letterSpacing: 1.8,
                    color: Theme.of(context).colorScheme.onSurface)),
          ]),
          actions: [
            if (MediaQuery.sizeOf(context).width >= 360)
              SizedBox(
                  width: 104,
                  child: Center(
                      child: Text(
                          _syncing
                              ? 'SYNCING'
                              : _updated
                                  ? 'UPDATED'
                                  : _syncError != null
                                      ? 'RESYNC FAILED'
                                      : '',
                          style: EyelerTypography.label))),
            IconButton(
                tooltip: 'Notifications',
                onPressed: () {},
                icon: const Icon(Icons.notifications_none_rounded)),
            Padding(
                padding: const EdgeInsets.only(right: EyelerSpacing.sm),
                child: Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.onSurface,
                        shape: BoxShape.circle),
                    child: IconButton(
                        padding: EdgeInsets.zero,
                        tooltip: 'Refresh',
                        onPressed: _syncing ? null : _resync,
                        icon: Icon(Icons.refresh,
                            size: 19,
                            color: Theme.of(context).colorScheme.surface))))
          ]),
      body: books.when(
        skipLoadingOnReload: true,
        skipError: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(
            message: friendlyError(error),
            onRetry: () => ref.invalidate(booksProvider)),
        data: (items) {
          final visible = _visibleBooks(items);
          final currentCount =
              items.where((book) => book.status != 'CLOSED').length;
          final historyCount = items.length - currentCount;
          final filtersActive = _marketFilter != null ||
              (_tab == _BookListTab.current &&
                  _statusFilter != _BookFilter.all);
          return RefreshIndicator(
            onRefresh: _resync,
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(EyelerSpacing.md,
                  EyelerSpacing.sm, EyelerSpacing.md, EyelerSpacing.xl),
              itemCount: visible.length + 1,
              itemBuilder: (context, index) {
                if (index > 0) {
                  final book = visible[index - 1];
                  return Padding(
                      key: ValueKey('book-card-${book.id}'),
                      padding: const EdgeInsets.only(bottom: EyelerSpacing.md),
                      child: _BookCard(book: book));
                }
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _WalletOverview(
                          currentCount: currentCount,
                          historyCount: historyCount,
                          books: items),
                      if (_syncError != null)
                        Text(_syncError!, style: EyelerTypography.body),
                      const Text('Your Books', style: EyelerTypography.display),
                      const SizedBox(height: EyelerSpacing.xs),
                      Text('$currentCount current · $historyCount in history',
                          style: EyelerTypography.body.copyWith(
                              color: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.color)),
                      const SizedBox(height: EyelerSpacing.lg),
                      Wrap(
                          spacing: EyelerSpacing.sm,
                          runSpacing: EyelerSpacing.xs,
                          children: [
                            ChoiceChip(
                                label: const Text('Current'),
                                selected: _tab == _BookListTab.current,
                                onSelected: (_) => setState(
                                    () => _tab = _BookListTab.current)),
                            ChoiceChip(
                                label: const Text('History'),
                                selected: _tab == _BookListTab.history,
                                onSelected: (_) => setState(
                                    () => _tab = _BookListTab.history)),
                            OutlinedButton.icon(
                                onPressed: () => _showFilters(items),
                                icon: const Icon(Icons.tune, size: 18),
                                label: Text(
                                    filtersActive ? 'Filter on' : 'Filter')),
                          ]),
                      const SizedBox(height: EyelerSpacing.md),
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
                                            builder: (_) =>
                                                const PositionsScreen())),
                                    icon: const Icon(Icons.arrow_forward),
                                    label: const Text('VIEW POSITIONS'))))
                      else if (visible.isEmpty)
                        EmptyStateCard(
                            icon: filtersActive
                                ? Icons.filter_alt_off_outlined
                                : Icons.menu_book_outlined,
                            title: filtersActive
                                ? 'NO MATCHING BOOKS'
                                : _tab == _BookListTab.history
                                    ? 'NO HISTORY YET'
                                    : 'NO CURRENT BOOKS',
                            message: filtersActive
                                ? 'Try another filter.'
                                : _tab == _BookListTab.history
                                    ? 'Closed Books will appear here.'
                                    : 'Your current Books will appear here.'),
                    ]);
              },
            ),
          );
        },
      ),
    );
  }
}

class _WalletOverview extends StatelessWidget {
  const _WalletOverview(
      {required this.currentCount,
      required this.historyCount,
      required this.books});
  final int currentCount;
  final int historyCount;
  final List<Book> books;

  @override
  Widget build(BuildContext context) {
    final reserveCap = books.fold<double>(
        0, (total, book) => total + book.defenseCap);
    final active = books.where((book) => book.status == 'ACTIVE').length;
    final paused = books
        .where((book) => book.status == 'SAFE_MODE' || book.status == 'PAUSED')
        .length;
    final ink = Theme.of(context).colorScheme.onSurface;
    final muted = Theme.of(context).textTheme.bodyMedium?.color ??
        EyelerColors.lightMuted;
    return Padding(
        padding: const EdgeInsets.fromLTRB(
            EyelerSpacing.md, EyelerSpacing.sm, EyelerSpacing.md, 30),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
                child: Text('Good morning, operator',
                    style: EyelerTypography.body.copyWith(color: muted))),
            Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                    color: EyelerColors.defend.withValues(alpha: .13),
                    borderRadius: BorderRadius.circular(EyelerRadii.pill)),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Container(
                      width: 7,
                      height: 7,
                      decoration: const BoxDecoration(
                          color: EyelerColors.defend, shape: BoxShape.circle)),
                  const SizedBox(width: 6),
                  Text('LIVE',
                      style: EyelerTypography.label.copyWith(
                          fontSize: 10, color: EyelerColors.defend))
                ]))
          ]),
          const SizedBox(height: EyelerSpacing.sm),
          Text('Protected capital',
              style: EyelerTypography.body.copyWith(color: muted)),
          const SizedBox(height: 2),
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('$${reserveCap.toStringAsFixed(2)}',
                style: EyelerTypography.display.copyWith(
                    fontSize: 40, color: ink)),
            const SizedBox(width: 10),
            Padding(
                padding: const EdgeInsets.only(bottom: 7),
                child: Text('AUSD cap',
                    style: EyelerTypography.body.copyWith(color: muted)))
          ]),
          const SizedBox(height: EyelerSpacing.md),
          Row(children: [
            _OverviewMetric(label: 'ACTIVE', value: '$active', positive: true),
            const SizedBox(width: EyelerSpacing.sm),
            _OverviewMetric(
                label: 'PAUSED', value: '$paused', positive: paused == 0),
            const SizedBox(width: EyelerSpacing.sm),
            _OverviewMetric(
                label: 'HISTORY', value: '$historyCount', positive: true),
          ]),
          const SizedBox(height: EyelerSpacing.lg),
          Row(children: [
            Text('Portfolio', style: EyelerTypography.title),
            const Spacer(),
            Text('$currentCount books',
                style: EyelerTypography.body.copyWith(color: muted))
          ])
        ]));
  }
}

class _OverviewMetric extends StatelessWidget {
  const _OverviewMetric(
      {required this.label, required this.value, required this.positive});
  final String label;
  final String value;
  final bool positive;

  @override
  Widget build(BuildContext context) => Expanded(
      child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              borderRadius: BorderRadius.circular(EyelerRadii.small),
              border: Border.all(color: EyelerColors.lightBorder)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(label,
                style: EyelerTypography.label.copyWith(
                    fontSize: 9,
                    letterSpacing: .7,
                    color: Theme.of(context).textTheme.bodyMedium?.color)),
            const SizedBox(height: 4),
            Text(value,
                style: EyelerTypography.metric.copyWith(
                    color: positive ? EyelerColors.defend : EyelerColors.exit))
          ])));
}

class _BookCard extends ConsumerWidget {
  const _BookCard({required this.book});
  final Book book;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final telemetry = ref.watch(bookDashboardProvider(book.id));
    return EyelerPanel(
      padding: EdgeInsets.zero,
      child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(EyelerRadii.card),
            onTap: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => BookDetailScreen(book: book))),
            child: Padding(
                padding: const EdgeInsets.all(EyelerSpacing.lg),
                child: telemetry.when(
                  skipLoadingOnReload: true,
                  skipError: true,
                  loading: () => const LinearProgressIndicator(),
                  error: (error, _) => Text(friendlyError(error)),
                  data: (dashboard) {
                    final state = dashboard.telemetry;
                    final currentBook = dashboard.book;
                    final summary = BookSummary.from(currentBook, state);
                    return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(children: [
                            EyelerIconTile(
                                icon: currentBook.market
                                        .toUpperCase()
                                        .contains('BTC')
                                    ? Icons.currency_bitcoin
                                    : Icons.hexagon_outlined,
                                color: currentBook.market
                                        .toUpperCase()
                                        .contains('BTC')
                                    ? EyelerColors.reduce
                                    : EyelerColors.info,
                                size: 48),
                            const SizedBox(width: EyelerSpacing.md),
                            Expanded(
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                  Text(currentBook.market,
                                      style: EyelerTypography.title),
                                  const SizedBox(height: 3),
                                  Text(
                                      '${currentBook.side.toLowerCase()} position',
                                      style: EyelerTypography.body.copyWith(
                                          color: Theme.of(context)
                                              .textTheme
                                              .bodyMedium
                                              ?.color)),
                                ])),
                          ]),
                          const SizedBox(height: EyelerSpacing.md),
                          StatusPill(
                              label: summary.label,
                              color: summary.color,
                              icon: summary.icon),
                          const SizedBox(height: EyelerSpacing.md),
                          Text(summary.message,
                              style: EyelerTypography.body.copyWith(
                                  color: Theme.of(context)
                                      .textTheme
                                      .bodyMedium
                                      ?.color)),
                          const SizedBox(height: EyelerSpacing.md),
                          if (currentBook.status != 'CLOSED' &&
                              state.mark != null &&
                              state.mark!.isFinite &&
                              state.mark! > 0) ...[
                            Text('MARK PRICE',
                                style: EyelerTypography.label.copyWith(
                                    color: Theme.of(context)
                                        .textTheme
                                        .bodyMedium
                                        ?.color)),
                            const SizedBox(height: 4),
                            Text(state.mark!.toStringAsFixed(2),
                                style: EyelerTypography.display),
                            const SizedBox(height: EyelerSpacing.md),
                          ],
                          if (currentBook.status != 'CLOSED' &&
                              state.liquidationDistance != null &&
                              state.liquidationDistance!.isFinite &&
                              currentBook.liquidationFloor > 0) ...[
                            Text(
                                'Position health  ${state.liquidationDistance!.toStringAsFixed(2)}% to liquidation',
                                style: EyelerTypography.section),
                            const SizedBox(height: EyelerSpacing.xs),
                            LinearProgressIndicator(
                                value: (state.liquidationDistance! /
                                        (currentBook.liquidationFloor * 2))
                                    .clamp(0.0, 1.0),
                                minHeight: 7,
                                borderRadius: BorderRadius.circular(20),
                                backgroundColor: EyelerColors.darkBorder,
                                color: state.liquidationDistance! <
                                        currentBook.liquidationFloor
                                    ? EyelerColors.reduce
                                    : EyelerColors.defend),
                            const SizedBox(height: EyelerSpacing.md),
                          ],
                          if (currentBook.status != 'CLOSED') ...[
                            Text('Unrealized P&L  ${_number(state.pnl)}',
                                style: EyelerTypography.metric
                                    .copyWith(fontSize: 16)),
                            const SizedBox(height: EyelerSpacing.xs),
                          ],
                          Wrap(
                              spacing: EyelerSpacing.sm,
                              runSpacing: EyelerSpacing.xs,
                              children: [
                                _BookFact(
                                    'Reserve',
                                    state.reserveAvailable == null
                                        ? 'Unavailable'
                                        : state.reserveAvailable!
                                            .toStringAsFixed(2)),
                                _BookFact('Defense cap',
                                    currentBook.defenseCap.toStringAsFixed(2)),
                                _BookFact('Time limit',
                                    '${(currentBook.timeLimitMs / 3600000).toStringAsFixed(0)}h'),
                              ]),
                          const SizedBox(height: EyelerSpacing.md),
                          Row(children: [
                            Expanded(
                                child: Text(
                                    currentBook.automationEnabled
                                        ? 'Automatic actions on'
                                        : 'Automatic actions off',
                                    style: EyelerTypography.body.copyWith(
                                        color: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.color))),
                            const Icon(Icons.arrow_forward_ios,
                                size: 17, color: EyelerColors.accent),
                          ]),
                          LiveSyncStatus(value: telemetry),
                        ]);
                  },
                )),
          )),
    );
  }

  String _number(double? value) =>
      value == null ? 'Unavailable' : value.toStringAsFixed(2);
}

class _BookFact extends StatelessWidget {
  const _BookFact(this.label, this.value);
  final String label;
  final String value;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
            color: Theme.of(context).brightness == Brightness.dark
                ? EyelerColors.darkCanvas.withValues(alpha: .55)
                : EyelerColors.lightBackground,
            border: Border.all(
                color: Theme.of(context).brightness == Brightness.dark
                    ? EyelerColors.darkBorder.withValues(alpha: .7)
                    : EyelerColors.lightBorder),
            borderRadius: BorderRadius.circular(12)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label,
              style: EyelerTypography.body.copyWith(
                  fontSize: 11,
                  color: Theme.of(context).textTheme.bodyMedium?.color)),
          Text(value, style: EyelerTypography.section),
        ]),
      );
}

class CreateBookEntry extends StatelessWidget {
  const CreateBookEntry({super.key, required this.position});
  final Position position;
  @override
  Widget build(BuildContext context) => CreateBookScreen(position: position);
}
