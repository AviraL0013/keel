import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'analytics_contract.dart';
import 'analytics_models.dart';
import 'analytics_screen.dart' show openAnalyticsMarket, openAnalyticsWallet;
import 'dashboard_chart.dart';
import 'dashboard_data.dart';
import 'dashboard_style.dart';
import 'wallet_screen.dart';
import 'dashboard_wallet.dart';

const dashboardSections = [
  'Overview',
  'Volume',
  'OI, Funding & Liquidations',
  'Revenue & Users',
  'Flows & TVL',
  'Wallets'
];

class AnalyticsDashboard extends ConsumerStatefulWidget {
  const AnalyticsDashboard({super.key, this.initialSection = 0});
  final int initialSection;
  @override
  ConsumerState<AnalyticsDashboard> createState() => _AnalyticsDashboardState();
}

class _AnalyticsDashboardState extends ConsumerState<AnalyticsDashboard>
    with WidgetsBindingObserver {
  late int section = widget.initialSection;
  DashboardRange range = DashboardRange.month;
  final search = TextEditingController();
  final tabKeys = List.generate(6, (_) => GlobalKey());
  final searchFocus = FocusNode(debugLabel: 'Analytics global search');
  Timer? timer;
  bool active = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    FocusManager.instance.addEarlyKeyEventHandler(_globalShortcut);
    WidgetsBinding.instance.addPostFrameCallback((_) => _revealTab());
    timer = Timer.periodic(const Duration(seconds: 60), (_) {
      if (active && (ModalRoute.of(context)?.isCurrent ?? true)) _refresh();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    active = state == AppLifecycleState.resumed;
    if (active) _refresh();
  }

  void _revealTab() {
    if (!mounted) return;
    final target = tabKeys[section].currentContext;
    if (target != null) Scrollable.ensureVisible(target, alignment: .5);
  }

  void _refresh() {
    ref.invalidate(dashboardSummaryProvider);
    ref.invalidate(dashboardHistoryProvider);
    ref.invalidate(dashboardFlowsProvider);
    ref.invalidate(dashboardMarketsProvider);
    ref.invalidate(dashboardLiquidationsProvider);
  }

  @override
  void dispose() {
    timer?.cancel();
    FocusManager.instance.removeEarlyKeyEventHandler(_globalShortcut);
    search.dispose();
    searchFocus.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  KeyEventResult _globalShortcut(KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.keyK &&
        (HardwareKeyboard.instance.isControlPressed ||
            HardwareKeyboard.instance.isMetaPressed) &&
        (ModalRoute.of(context)?.isCurrent ?? true)) {
      _focusSearch();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  void _focusSearch() {
    if (MediaQuery.sizeOf(context).width < 700) {
      _openSearch();
    } else {
      searchFocus.requestFocus();
    }
  }

  void _openSearch([String query = '']) =>
      Navigator.of(context).push(MaterialPageRoute<void>(
          fullscreenDialog: true,
          builder: (_) => AnalyticsDark(
              child: Scaffold(
                  appBar: AppBar(title: const Text('Search wallets')),
                  body: AnalyticsWalletSearchScreen(
                      initialQuery: query, autofocus: true)))));
  void _submit(String value) {
    final address = value.trim();
    if (isAnalyticsAddress(address)) {
      openAnalyticsWallet(context, address);
    } else {
      _openSearch(address);
    }
  }

  @override
  Widget build(BuildContext context) => AnalyticsDark(
          child: CallbackShortcuts(
              bindings: {
            const SingleActivator(LogicalKeyboardKey.keyK, control: true):
                _focusSearch,
            const SingleActivator(LogicalKeyboardKey.keyK, meta: true):
                _focusSearch,
          },
              child: Focus(
                  autofocus: true,
                  child: Scaffold(
                      body: SafeArea(
                          child: Column(children: [
                    Container(
                        decoration: const BoxDecoration(
                            color: AnalyticsPalette.background,
                            border: Border(
                                bottom: BorderSide(
                                    color: AnalyticsPalette.border))),
                        child: Center(
                            child: ConstrainedBox(
                                constraints:
                                    const BoxConstraints(maxWidth: 1600),
                                child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                        horizontal: 24, vertical: 10),
                                    child: LayoutBuilder(
                                        builder: (context, constraints) {
                                      final desktop =
                                          constraints.maxWidth >= 1150;
                                      final phone = constraints.maxWidth < 650;
                                      final timeframe = Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            for (final value
                                                in DashboardRange.values)
                                              TextButton(
                                                  key: ValueKey(
                                                      'range_${value.label}'),
                                                  onPressed: () => setState(
                                                      () => range = value),
                                                  style: TextButton.styleFrom(
                                                      padding:
                                                          const EdgeInsets.symmetric(
                                                              horizontal: 8),
                                                      minimumSize:
                                                          const Size(48, 48),
                                                      foregroundColor:
                                                          range == value
                                                              ? AnalyticsPalette
                                                                  .text
                                                              : AnalyticsPalette
                                                                  .muted,
                                                      backgroundColor:
                                                          range == value
                                                              ? AnalyticsPalette
                                                                  .elevated
                                                              : null),
                                                  child: Text(value.label)),
                                          ]);
                                      final tabs = SingleChildScrollView(
                                          scrollDirection: Axis.horizontal,
                                          child: Row(children: [
                                            for (var i = 0;
                                                i < dashboardSections.length;
                                                i++)
                                              KeyedSubtree(
                                                  key: tabKeys[i],
                                                  child: TextButton(
                                                      key: ValueKey(
                                                          'section_$i'),
                                                      onPressed: () {
                                                        setState(
                                                            () => section = i);
                                                        WidgetsBinding.instance
                                                            .addPostFrameCallback(
                                                                (_) =>
                                                                    _revealTab());
                                                      },
                                                      style: TextButton.styleFrom(
                                                          padding:
                                                              const EdgeInsets
                                                                  .symmetric(
                                                                  horizontal:
                                                                      12),
                                                          foregroundColor: section == i
                                                              ? AnalyticsPalette
                                                                  .text
                                                              : AnalyticsPalette
                                                                  .muted,
                                                          shape:
                                                              const RoundedRectangleBorder(),
                                                          side: BorderSide(
                                                              color: section == i
                                                                  ? AnalyticsPalette
                                                                      .accent
                                                                  : Colors
                                                                      .transparent)),
                                                      child: Text(
                                                          dashboardSections[i],
                                                          style: const TextStyle(
                                                              fontSize: 11)))),
                                          ]));
                                      return Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Row(children: [
                                              Image.asset(
                                                  'assets/branding/eyeler-eye.png',
                                                  width: 36,
                                                  height: 36),
                                              const SizedBox(width: 10),
                                              const Expanded(
                                                  child: Text('Analytics',
                                                      maxLines: 1,
                                                      overflow:
                                                          TextOverflow.ellipsis,
                                                      style: TextStyle(
                                                          fontSize: 21,
                                                          fontWeight: FontWeight
                                                              .w600))),
                                              if (phone)
                                                IconButton(
                                                    key: const Key(
                                                        'mobile_search'),
                                                    tooltip: 'Search address',
                                                    onPressed: _openSearch,
                                                    icon: const Icon(
                                                        Icons.search))
                                              else
                                                SizedBox(
                                                    width: desktop ? 270 : 220,
                                                    child: TextField(
                                                        key: const Key(
                                                            'global_search'),
                                                        controller: search,
                                                        focusNode: searchFocus,
                                                        autocorrect: false,
                                                        enableSuggestions:
                                                            false,
                                                        onSubmitted: _submit,
                                                        decoration: const InputDecoration(
                                                            hintText:
                                                                'Search address…',
                                                            prefixIcon: Icon(
                                                                Icons.search,
                                                                size: 18),
                                                            suffixText:
                                                                '⌘ / Ctrl K'))),
                                              if (!phone) ...[
                                                const SizedBox(width: 16),
                                                _openAppButton()
                                              ],
                                            ]),
                                            const SizedBox(height: 10),
                                            if (desktop)
                                              Row(children: [
                                                Expanded(child: tabs),
                                                const SizedBox(width: 20),
                                                timeframe
                                              ])
                                            else ...[
                                              tabs,
                                              const SizedBox(height: 8),
                                              Row(children: [
                                                timeframe,
                                                const Spacer(),
                                                IconButton(
                                                    tooltip:
                                                        'Refresh analytics',
                                                    onPressed: _refresh,
                                                    icon: const Icon(
                                                        Icons.refresh,
                                                        size: 18))
                                              ]),
                                              if (phone)
                                                SizedBox(
                                                    width: double.infinity,
                                                    child: _openAppButton()),
                                            ],
                                          ]);
                                    }))))),
                    Expanded(
                        child: AnimatedSwitcher(
                      duration: const Duration(milliseconds: 180),
                      child: section == 5
                          ? const _WalletsSection(key: ValueKey('wallets'))
                          : ListView(
                              key: ValueKey('dashboard_section_$section'),
                              padding:
                                  const EdgeInsets.fromLTRB(24, 30, 24, 36),
                              children: [
                                Center(
                                    child: ConstrainedBox(
                                        constraints: const BoxConstraints(
                                            maxWidth: 1440),
                                        child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                  section == 0
                                                      ? 'Protocol overview'
                                                      : dashboardSections[
                                                          section],
                                                  style: const TextStyle(
                                                      fontSize: 28,
                                                      letterSpacing: -.8,
                                                      fontWeight:
                                                          FontWeight.w600)),
                                              const SizedBox(height: 8),
                                              const Text(
                                                  'Eyeler Analytics · Perpl on Monad',
                                                  style: TextStyle(
                                                      color: AnalyticsPalette
                                                          .muted,
                                                      fontSize: 12)),
                                              const SizedBox(height: 28),
                                              if (section == 0)
                                                _OverviewSection(range: range),
                                              if (section == 1) ...[
                                                _HistoryCard(
                                                    metric: 'volume',
                                                    range: range,
                                                    brush: true),
                                                const SizedBox(height: 24),
                                                const DashboardMarketsTable()
                                              ],
                                              if (section == 2) ...[
                                                _HistoryCard(
                                                    metric: 'oi', range: range),
                                                const SizedBox(height: 24),
                                                const DashboardMarketsTable(
                                                    funding: true),
                                                const SizedBox(height: 24),
                                                DashboardLiquidations(
                                                    range: range),
                                              ],
                                              if (section == 3) ...[
                                                const DashboardGrid(
                                                    columns: 3,
                                                    children: [
                                                      _SummaryKpi(
                                                          window: '30d',
                                                          field: 'fees',
                                                          label: 'Fees (30d)',
                                                          coverage:
                                                              'Last 30 days'),
                                                      _SummaryKpi(
                                                          window: '30d',
                                                          field: 'revenue',
                                                          label:
                                                              'Revenue (30d)',
                                                          coverage:
                                                              'Protocol fees only · last 30 days'),
                                                      _SummaryKpi(
                                                          window: '30d',
                                                          field: 'activeUsers',
                                                          label:
                                                              'Traders (30d)',
                                                          coverage:
                                                              'Distinct owners · last 30 days',
                                                          money: false),
                                                    ]),
                                                const SizedBox(height: 24),
                                                DashboardGrid(children: [
                                                  _HistoryCard(
                                                      metric: 'fees',
                                                      range: range),
                                                  _HistoryCard(
                                                      metric: 'active_users',
                                                      range: range)
                                                ]),
                                                const SizedBox(height: 24),
                                                _RevenueHistoryCard(
                                                    range: range),
                                              ],
                                              if (section == 4) ...[
                                                const _FlowsKpi(),
                                                const SizedBox(height: 24),
                                                DashboardGrid(children: [
                                                  DashboardFlowsChart(
                                                      range: range),
                                                  _HistoryCard(
                                                      metric: 'tvl',
                                                      range: range)
                                                ]),
                                              ],
                                              const SizedBox(height: 36),
                                              const Divider(),
                                              const SizedBox(height: 18),
                                              const Text(
                                                  'Monad mainnet · USD values · UTC dates · Unavailable values are never treated as zero.',
                                                  style: TextStyle(
                                                      fontSize: 11,
                                                      height: 1.6,
                                                      color: AnalyticsPalette
                                                          .muted)),
                                            ]))),
                              ],
                            ),
                    )),
                  ]))))));

  Widget _openAppButton() => OutlinedButton.icon(
      onPressed: () async {
        final opened = await launchUrl(Uri.parse('https://app.eyeler.xyz/'),
            mode: LaunchMode.externalApplication);
        if (!opened && mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text('Could not open Eyeler. Please retry.')));
        }
      },
      icon: const Icon(Icons.north_east, size: 16),
      label: const Text('Open Eyeler app', style: TextStyle(fontSize: 11)));
}

class _OverviewSection extends StatelessWidget {
  const _OverviewSection({required this.range});
  final DashboardRange range;
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const DashboardGrid(columns: 4, children: [
          _SummaryKpi(
              window: '24h',
              field: 'volume',
              label: '24h Volume',
              coverage: 'Last 24 hours'),
          _SummaryKpi(
              window: 'all',
              field: 'volume',
              label: 'All-time Volume',
              coverage: 'Since first candle'),
          _SummaryKpi(
              window: '24h',
              field: 'openInterest',
              label: 'Open Interest',
              coverage: 'Current snapshot'),
          _SummaryKpi(
              window: '24h',
              field: 'tvl',
              label: 'TVL',
              coverage: 'Current snapshot'),
        ]),
        const SizedBox(height: 24),
        DashboardGrid(children: [
          _HistoryCard(metric: 'volume', range: range),
          _HistoryCard(metric: 'oi', range: range),
          _HistoryCard(metric: 'tvl', range: range),
          _HistoryCard(metric: 'active_users', range: range),
          _HistoryCard(metric: 'fees', range: range),
          DashboardFlowsChart(range: range),
        ]),
        const SizedBox(height: 24),
        const DashboardGrid(columns: 4, children: [
          _FlowsKpi(),
          _SummaryKpi(
              window: '24h',
              field: 'activeUsers',
              label: '24h Traders',
              coverage: 'Distinct owners · last 24 hours',
              money: false),
          _SummaryKpi(
              window: '30d',
              field: 'activeUsers',
              label: 'Traders (30d)',
              coverage: 'Distinct owners · last 30 days',
              money: false),
          _SummaryKpi(
              window: '30d',
              field: 'fees',
              label: 'Fees (30d)',
              coverage: 'Last 30 days'),
        ]),
        const SizedBox(height: 32),
        const Text('All-time / Since first data',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 14),
        const _AllTimeStrip(),
        const SizedBox(height: 28),
        const DashboardMarketsTable(),
      ]);
}

class _SummaryKpi extends ConsumerWidget {
  const _SummaryKpi(
      {required this.window,
      required this.field,
      required this.label,
      required this.coverage,
      this.money = true,
      this.bare = false});
  final String window, field, label, coverage;
  final bool money, bare;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ref.watch(dashboardSummaryProvider(window));
    final response = result.asData?.value;
    final metric = response?.data.metrics[field];
    final note = metric?.note;
    var actualCoverage = coverage;
    if (window == 'all') {
      actualCoverage = field == 'volume' && note?.contains('candle') == true
          ? 'Since first candle · listed markets'
          : response?.coverage?.label ?? 'Coverage unavailable';
    }
    final reason = result.hasError
        ? 'Summary unavailable. Refresh to retry.'
        : metric?.note ?? 'The source has not supplied a verified value.';
    return Tooltip(
        message: [
          if (note != null) note,
          if (response != null)
            '${analyticsSource(response.source)} · ${utcExact(response.asOf)}',
          if (response?.stale == true) 'Stale / partial source'
        ].join('\n'),
        child: DashboardKpi(
            label: label,
            value: metric?.value,
            delta: window == '24h' &&
                    metric?.previous != null &&
                    metric?.value != null
                ? metric?.changePct
                : null,
            coverage:
                '$actualCoverage${response?.stale == true ? ' · Stale / partial' : ''}',
            reason: reason,
            money: money,
            bare: bare,
            loading: result.isLoading && !result.hasValue));
  }
}

class _AllTimeStrip extends StatelessWidget {
  const _AllTimeStrip();
  @override
  Widget build(BuildContext context) {
    const children = [
      _SummaryKpi(
          window: 'all',
          field: 'volume',
          label: 'Volume',
          coverage: 'Since first candle',
          bare: true),
      _SummaryKpi(
          window: 'all',
          field: 'fees',
          label: 'Fees',
          coverage: 'Since first data',
          bare: true),
      _SummaryKpi(
          window: 'all',
          field: 'activeUsers',
          label: 'Traders',
          coverage: 'Since first data',
          money: false,
          bare: true),
      _SummaryKpi(
          window: 'all',
          field: 'netFlows',
          label: 'Net flows',
          coverage: 'Since first data',
          bare: true),
    ];
    return Card(
        child: LayoutBuilder(
            builder: (context, constraints) => constraints.maxWidth >= 1000
                ? IntrinsicHeight(
                    child: Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                        for (var i = 0; i < children.length; i++) ...[
                          if (i > 0) const VerticalDivider(width: 1),
                          Expanded(child: children[i]),
                        ],
                      ]))
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                        for (var i = 0; i < children.length; i++) ...[
                          if (i > 0) const Divider(),
                          children[i]
                        ],
                      ])));
  }
}

class _FlowsKpi extends ConsumerWidget {
  const _FlowsKpi();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = ref.watch(dashboardFlowsProvider('24h'));
    final value = data.asData?.value;
    return DashboardCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('24h Flows',
          style: TextStyle(fontSize: 12, color: AnalyticsPalette.muted)),
      const SizedBox(height: 16),
      if (data.isLoading)
        const DashboardSkeleton(height: 60)
      else
        Wrap(spacing: 8, runSpacing: 10, children: [
          for (final item in [
            (value?.data.deposits, 'Deposited', AnalyticsPalette.up),
            (value?.data.withdrawals, 'Withdrawn', AnalyticsPalette.down)
          ])
            Tooltip(
                message: item.$1 ??
                    'Gross external flows are not available for this window.',
                child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    decoration: BoxDecoration(
                        color: item.$3.withValues(alpha: .1),
                        borderRadius: BorderRadius.circular(6)),
                    child: Text(
                        '${item.$2 == 'Withdrawn' && item.$1 != null ? '−' : ''}${item.$1 == null ? '—' : AnalyticsNumbers.compact(item.$1, places: 2)} ${item.$2}',
                        style: TextStyle(
                            fontSize: 13,
                            color: item.$1 == null
                                ? AnalyticsPalette.muted
                                : item.$3)))),
        ]),
      const SizedBox(height: 14),
      Text(
          value == null
              ? 'Flow source unavailable'
              : '${analyticsSource(value.source)} · last 24 hours${value.stale ? ' · Stale / partial' : ''}',
          style: const TextStyle(fontSize: 10, color: AnalyticsPalette.muted)),
    ]));
  }
}

class _HistoryCard extends ConsumerWidget {
  const _HistoryCard(
      {required this.metric, required this.range, this.brush = false});
  final String metric;
  final DashboardRange range;
  final bool brush;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(dashboardHistoryProvider((metric, range)));
    final value = state.asData?.value;
    final total = value?.data.total;
    final snapshot = metric == 'oi' || metric == 'tvl';
    final summary = snapshot
        ? ref.watch(dashboardSummaryProvider('24h')).asData?.value
        : null;
    final summaryField = metric == 'oi' ? 'openInterest' : metric;
    final titles = {
      'volume': 'Trading volume',
      'oi': 'Open interest',
      'tvl': 'TVL',
      'fees': 'Trading fees',
      'active_users': 'Daily active users'
    };
    final descriptions = {
      'volume':
          'Daily traded notional and cumulative volume in the visible period.',
      'oi': 'One side of open positions, valued at the current mark.',
      'tvl': 'Collateral reported by the listed Perpl markets.',
      'fees': 'Gross trading fees paid, less reported rebates.',
      'active_users': 'Distinct account owners with a settled trade each day.'
    };
    final marketSeries = value?.data.markets ?? [];
    final verifiedCoverage = metric == 'active_users' && total != null
        ? ' · ${total.points.where((point) => point.value != null).length}/${total.points.length} verified daily values'
        : '';
    final coverage = range == DashboardRange.all
        ? 'Up to 2 years · available history'
        : 'Last ${range.days} days · completed UTC days';
    final hasHistory = total?.points.any((p) => p.value != null) ?? false;
    final observed = value?.data.historyStartedAt ??
        total?.points.where((p) => p.value != null).firstOrNull?.time;
    return DashboardChartCard(
      key: ValueKey('history_${metric}_${range.name}'),
      title: titles[metric]!,
      description: descriptions[metric]!,
      series: marketSeries.isNotEmpty
          ? marketSeries
          : [
              if (total != null)
                DashboardSeries('Protocol total',
                    total.points.map((p) => p.toView()).toList())
            ],
      source: value == null ? null : analyticsSource(value.source),
      asOf: value?.asOf,
      stale: value?.stale ?? false,
      coverage: '$coverage$verifiedCoverage',
      loading: state.isLoading && !state.hasValue,
      snapshot: snapshot ? summary?.data.metrics[summaryField]?.value : null,
      unavailableReason: value?.data.unavailableReason ??
          (snapshot
              ? 'Current snapshot. ${observed == null ? 'History start date is not reported.' : 'History recording since ${utcDate(observed)}.'}'
              : state.hasError
                  ? 'History unavailable from the source. Retry this chart.'
                  : total?.points.isEmpty == true
                      ? 'No observations in this range.'
                      : 'No verified history in this range. Unavailable buckets remain unknown.'),
      retry: state.hasError
          ? () => ref.invalidate(dashboardHistoryProvider((metric, range)))
          : null,
      initialType: snapshot
          ? DashboardChartType.area
          : metric == 'active_users'
              ? DashboardChartType.line
              : DashboardChartType.bar,
      money: metric != 'active_users',
      cumulative: metric == 'volume',
      granularity: metric == 'volume',
      stacked: marketSeries.isNotEmpty,
      brush: brush,
      note: metric == 'volume' && marketSeries.isEmpty && hasHistory
          ? 'Per-market volume history is not supplied. Showing the protocol total; market snapshots appear below.'
          : null,
    );
  }
}

class _RevenueHistoryCard extends ConsumerWidget {
  const _RevenueHistoryCard({required this.range});
  final DashboardRange range;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(dashboardSummaryProvider('30d'));
    final response = state.asData?.value;
    final history = response?.data.revenueHistory;
    final (from, to) = ref.read(dashboardApiProvider).bounds(range);
    final points = history?.data.points
            .where((p) => !p.time.isBefore(from) && p.time.isBefore(to))
            .map((p) => p.toView())
            .toList() ??
        <AnalyticsPoint>[];
    return DashboardChartCard(
        title: 'Protocol revenue',
        description: 'Protocol fees, excluding insurance and builder fees.',
        series: [DashboardSeries('Revenue', points)],
        loading: state.isLoading,
        source: history == null ? null : analyticsSource(history.source),
        asOf: history?.asOf,
        stale: history?.stale ?? false,
        unavailableReason: response?.data.metrics['revenue']?.note ??
            'Daily revenue is not supplied. The verified 30-day total is shown above when available.',
        coverage: history == null
            ? 'Daily history unavailable'
            : '${utcDate(history.data.from)} to ${utcDate(history.data.to)} UTC',
        retry: state.hasError
            ? () => ref.invalidate(dashboardSummaryProvider('30d'))
            : null);
  }
}

class DashboardFlowsChart extends ConsumerWidget {
  const DashboardFlowsChart({super.key, required this.range});
  final DashboardRange range;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final window = range == DashboardRange.week
        ? '7d'
        : range == DashboardRange.month
            ? '30d'
            : 'all';
    final state = ref.watch(dashboardFlowsProvider(window));
    final response = state.asData?.value;
    final (from, to) = ref.read(dashboardApiProvider).bounds(range);
    final buckets = dailyAnalyticsFlows(response?.data.buckets
            .where((b) => !b.time.isBefore(from) && b.time.isBefore(to))
            .toList() ??
        []);
    return DashboardChartCard(
      title: 'Deposits & withdrawals',
      description:
          'Daily observed collateral flows. Withdrawals plot below zero; the line shows net flow.',
      series: [
        DashboardSeries('Deposits',
            buckets.map((b) => AnalyticsPoint(b.time, b.deposits)).toList()),
        DashboardSeries(
            'Withdrawals',
            buckets
                .map((b) => AnalyticsPoint(b.time,
                    AnalyticsDecimal.parse(b.withdrawals).negative.toString()))
                .toList()),
        DashboardSeries('Net flow',
            buckets.map((b) => AnalyticsPoint(b.time, b.net)).toList()),
      ],
      colors: const [
        AnalyticsPalette.up,
        AnalyticsPalette.down,
        AnalyticsPalette.accent
      ],
      lineSeries: const {'Net flow'},
      note: buckets.isEmpty
          ? null
          : 'UTC days sum returned source buckets only. Missing dates are not zero.',
      loading: state.isLoading,
      unavailableReason: state.hasError
          ? 'Flows unavailable from the source. Retry this chart.'
          : 'No verified deposit or withdrawal history in this range.',
      source: response == null ? null : analyticsSource(response.source),
      asOf: response?.asOf,
      stale: response?.stale ?? false,
      coverage:
          '${range == DashboardRange.all ? 'Available history' : 'Last ${range.days} days'} · ${response?.coverage?.label ?? 'Coverage not reported'}',
      retry: state.hasError
          ? () => ref.invalidate(dashboardFlowsProvider(window))
          : null,
    );
  }
}

class DashboardMarketsTable extends ConsumerWidget {
  const DashboardMarketsTable({super.key, this.funding = false});
  final bool funding;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(dashboardMarketsProvider);
    final response = state.asData?.value;
    final markets = response?.data ?? [];
    return DashboardCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(funding ? 'OI & funding by market' : 'Markets',
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
      const SizedBox(height: 6),
      const Text(
          'Current snapshots · select a market for price and funding history.',
          style: TextStyle(fontSize: 12, color: AnalyticsPalette.muted)),
      const SizedBox(height: 16),
      if (state.isLoading)
        const DashboardSkeleton()
      else if (markets.isEmpty)
        DashboardUnavailable(
            state.hasError
                ? 'Market snapshots unavailable.'
                : 'No listed markets.',
            retry: () => ref.invalidate(dashboardMarketsProvider))
      else
        LayoutBuilder(builder: (context, constraints) {
          String money(String? v) =>
              v == null ? '—' : AnalyticsNumbers.compact(v, places: 2);
          Widget rate(V1Market market) => Tooltip(
              message: market.fundingRate == null
                  ? 'Funding rate not supplied.'
                  : '${market.fundingRate} fraction per funding interval',
              child: Text(
                  market.fundingRate == null
                      ? '—'
                      : '${(AnalyticsDecimal.parse(market.fundingRate!) + AnalyticsDecimal.parse('0')).units == BigInt.zero ? '0' : _fundingRate(market.fundingRate!)}%',
                  style: TextStyle(
                      color: market.fundingRate == null
                          ? AnalyticsPalette.muted
                          : market.fundingRate!.startsWith('-')
                              ? AnalyticsPalette.down
                              : AnalyticsPalette.up)));
          if (constraints.maxWidth < 650) {
            return Column(children: [
              for (final market in markets)
                InkWell(
                    onTap: () => openAnalyticsMarket(context, market.symbol),
                    child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        child: Column(children: [
                          Row(children: [
                            Text(market.symbol,
                                style: const TextStyle(
                                    fontWeight: FontWeight.w600)),
                            const Spacer(),
                            const Icon(Icons.chevron_right, size: 18)
                          ]),
                          const SizedBox(height: 12),
                          Row(children: [
                            const Text('24h volume',
                                style: TextStyle(
                                    color: AnalyticsPalette.muted,
                                    fontSize: 12)),
                            const Spacer(),
                            Text(money(market.volume24h))
                          ]),
                          const SizedBox(height: 10),
                          Row(children: [
                            const Text('Open interest',
                                style: TextStyle(
                                    color: AnalyticsPalette.muted,
                                    fontSize: 12)),
                            const Spacer(),
                            Text(money(market.openInterest))
                          ]),
                          const SizedBox(height: 10),
                          Row(children: [
                            const Text('Funding / interval',
                                style: TextStyle(
                                    color: AnalyticsPalette.muted,
                                    fontSize: 12)),
                            const Spacer(),
                            rate(market)
                          ]),
                          const SizedBox(height: 16),
                          const Divider(),
                        ]))),
            ]);
          }
          return SizedBox(
              width: double.infinity,
              child: DataTable(
                horizontalMargin: 0,
                columnSpacing: 24,
                dataRowMinHeight: 56,
                dataRowMaxHeight: 64,
                columns: const [
                  DataColumn(label: Text('Market')),
                  DataColumn(label: Text('24h Volume'), numeric: true),
                  DataColumn(label: Text('Open Interest'), numeric: true),
                  DataColumn(label: Text('Funding / interval'), numeric: true),
                  DataColumn(label: Text('Mark price'), numeric: true)
                ],
                rows: [
                  for (final market in markets)
                    DataRow(cells: [
                      DataCell(TextButton(
                          onPressed: () =>
                              openAnalyticsMarket(context, market.symbol),
                          child: Text(market.symbol))),
                      DataCell(Tooltip(
                          message: market.volume24h ?? 'Volume unavailable',
                          child: Text(money(market.volume24h)))),
                      DataCell(Tooltip(
                          message: market.openInterest ??
                              'Open interest unavailable',
                          child: Text(money(market.openInterest)))),
                      DataCell(rate(market)),
                      DataCell(Tooltip(
                          message: market.markPrice ?? 'Mark unavailable',
                          child: Text(money(market.markPrice)))),
                    ])
                ],
              ));
        }),
      if (response != null)
        Text(
            '${analyticsSource(response.source)} · ${utcExact(response.asOf)}${response.stale ? ' · Stale / partial' : ''}',
            style:
                const TextStyle(fontSize: 10, color: AnalyticsPalette.muted)),
    ]));
  }
}

String _fundingRate(String rate) {
  final decimal = AnalyticsDecimal.parse(rate);
  return AnalyticsDecimal(decimal.units * BigInt.from(100), decimal.scale)
      .toString();
}

class DashboardLiquidations extends ConsumerWidget {
  const DashboardLiquidations({super.key, required this.range});
  final DashboardRange range;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(dashboardLiquidationsProvider(range));
    final response = state.asData?.value;
    final data = response?.data;
    final markets =
        ref.watch(dashboardMarketsProvider).asData?.value.data ?? [];
    final names = {for (final m in markets) m.id: m.symbol};
    // Only a complete, unpaginated response proves daily totals. Do not chart
    // the first page as though it represented all liquidation events.
    final complete = response?.coverage?.completeHistory == true &&
        data?.nextCursor == null &&
        data?.count == data?.items.length;
    final days = <DateTime, List<String?>>{};
    if (complete) {
      for (final item in data!.items) {
        final day =
            DateTime.utc(item.time.year, item.time.month, item.time.day);
        days.putIfAbsent(day, () => []).add(item.notional);
      }
    }
    final observedPoints = days.entries
        .map((e) => AnalyticsPoint(e.key, AnalyticsDecimal.sum(e.value)))
        .toList()
      ..sort((a, b) => a.at.compareTo(b.at));
    return Column(children: [
      DashboardChartCard(
          title: 'Daily liquidations',
          description: 'Liquidated notional for complete observed days.',
          series: [
            DashboardSeries(
                'Notional',
                data?.dailyNotional?.points.map((p) => p.toView()).toList() ??
                    observedPoints)
          ],
          loading: state.isLoading,
          unavailableReason:
              'Complete daily liquidation totals are unavailable. The feed shows individually observed events.',
          source: response == null ? null : analyticsSource(response.source),
          asOf: response?.asOf,
          stale: response?.stale ?? false,
          coverage: response?.coverage?.label),
      const SizedBox(height: 24),
      DashboardCard(
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('Liquidations feed',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Text(
            data?.count == null
                ? 'Total unavailable · observed events only'
                : '${data!.count} events in requested range',
            style:
                const TextStyle(fontSize: 12, color: AnalyticsPalette.muted)),
        if (state.isLoading)
          const DashboardSkeleton()
        else if (data == null || data.items.isEmpty)
          DashboardUnavailable(
              state.hasError
                  ? 'Liquidation feed unavailable.'
                  : 'No observed liquidation events in this range.',
              retry: state.hasError
                  ? () => ref.invalidate(dashboardLiquidationsProvider(range))
                  : null)
        else ...[
          for (final item in data.items)
            Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Wrap(
                    spacing: 12,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      TextButton(
                          onPressed: names[item.marketId] == null
                              ? null
                              : () => openAnalyticsMarket(
                                  context, names[item.marketId]!),
                          child: Text(names[item.marketId] ??
                              'Market ${item.marketId}')),
                      Text(item.side ?? 'Side unavailable'),
                      Text(item.notional == null
                          ? '—'
                          : AnalyticsNumbers.compact(item.notional, places: 2)),
                      if (item.address != null)
                        TextButton(
                            onPressed: () =>
                                openAnalyticsWallet(context, item.address!),
                            child: Text(
                                '${item.address!.substring(0, 8)}…${item.address!.substring(36)}')),
                      Text(utcExact(item.time),
                          style: const TextStyle(
                              fontSize: 11, color: AnalyticsPalette.muted)),
                    ])),
          if (data.nextCursor != null)
            const Text(
                'Showing the latest 100 observed events. Daily totals require complete history.',
                style: TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
        ],
      ])),
    ]);
  }
}

class _WalletsSection extends StatefulWidget {
  const _WalletsSection({super.key});
  @override
  State<_WalletsSection> createState() => _WalletsSectionState();
}

class _WalletsSectionState extends State<_WalletsSection> {
  bool watchlist = false;
  @override
  Widget build(BuildContext context) => Column(children: [
        Padding(
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              TextButton(
                  onPressed: () => setState(() => watchlist = false),
                  child: const Text('Search')),
              TextButton(
                  onPressed: () => setState(() => watchlist = true),
                  child: const Text('Watchlist & compare')),
            ])),
        Expanded(
            child: watchlist
                ? const DashboardCompareScreen(embedded: true)
                : const AnalyticsWalletSearchScreen()),
      ]);
}
