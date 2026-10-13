import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'strategy_repository.dart';

class AutopilotScreen extends ConsumerStatefulWidget {
  const AutopilotScreen({super.key});
  @override
  ConsumerState<AutopilotScreen> createState() => _AutopilotScreenState();
}

class _AutopilotScreenState extends ConsumerState<AutopilotScreen> {
  late Future<List<StrategyEntry>> strategies;
  bool killed = false;
  bool busy = false;
  String? error;
  @override
  void initState() {
    super.initState();
    refresh();
  }

  void refresh() {
    final repo = ref.read(strategyRepositoryProvider);
    setState(() {
      strategies = repo.list();
      error = null;
    });
    repo.killed().then((value) {
      if (mounted) setState(() => killed = value);
    }).catchError((Object value) {
      if (mounted) setState(() => error = value.toString());
    });
  }

  Future<void> kill() async {
    setState(() => busy = true);
    try {
      await ref.read(strategyRepositoryProvider).kill();
      refresh();
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> resetKill() async {
    setState(() => busy = true);
    try {
      await ref.read(strategyRepositoryProvider).resetKill();
      if (mounted) refresh();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Autopilot'),
          actions: [
            IconButton(
              onPressed: refresh,
              tooltip: 'Refresh strategies',
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
              'Paper strategies simulate orders. Live strategies place real Perpl orders after a reviewed start.',
            ),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      killed ? 'Kill switch ON' : 'Kill switch OFF',
                      key: const Key('strategyKillState'),
                    ),
                    const Text(
                      'Halts new orders and queues cancellation of strategy-owned live orders. Open positions remain exposed.',
                    ),
                    const SizedBox(height: 8),
                    FilledButton.icon(
                      onPressed: busy || killed ? null : kill,
                      icon: const Icon(Icons.stop_circle_outlined),
                      label: const Text('Stop all strategies'),
                    ),
                    if (killed) ...[
                      const Text(
                          'Reset clears the kill switch. Strategies stay halted until a new start.'),
                      TextButton(
                          onPressed: busy ? null : resetKill,
                          child: const Text('Reset kill switch')),
                    ],
                  ],
                ),
              ),
            ),
            if (error != null)
              Padding(padding: const EdgeInsets.all(8), child: Text(error!)),
            const SizedBox(height: 12),
            FutureBuilder<List<StrategyEntry>>(
              future: strategies,
              builder: (context, snapshot) {
                if (!snapshot.hasData && !snapshot.hasError) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return const Text(
                      'Strategies unavailable. Refresh to retry.');
                }
                if (snapshot.data!.isEmpty) {
                  return const Text(
                    'No strategies yet. Start with paper mode to evaluate risk limits.',
                  );
                }
                return Column(
                  children: snapshot.data!
                      .map(
                        (entry) => Card(
                          child: ListTile(
                            title: Text(
                              '${entry.kind == 'GRID' ? 'Grid' : 'Market maker'} · Market ${entry.marketId}',
                            ),
                            subtitle: Text(
                              '${entry.mode} · ${entry.status} · Account ${entry.accountId}',
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => Navigator.of(context)
                                .push(
                                  MaterialPageRoute<void>(
                                    builder: (_) =>
                                        StrategyDashboardScreen(id: entry.id),
                                  ),
                                )
                                .then((_) => refresh()),
                          ),
                        ),
                      )
                      .toList(),
                );
              },
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () => Navigator.of(context)
                  .push(
                    MaterialPageRoute<void>(
                      builder: (_) => const StrategySetupScreen(),
                    ),
                  )
                  .then((_) => refresh()),
              icon: const Icon(Icons.add),
              label: const Text('Set up strategy'),
            ),
          ],
        ),
      );
}

class StrategySetupScreen extends ConsumerStatefulWidget {
  const StrategySetupScreen({super.key});
  @override
  ConsumerState<StrategySetupScreen> createState() =>
      _StrategySetupScreenState();
}

class _StrategySetupScreenState extends ConsumerState<StrategySetupScreen> {
  late Future<StrategySetup> setup;
  int step = 0;
  String kind = 'GRID';
  String mode = 'PAPER';
  StrategyAccount? account;
  StrategyMarket? market;
  bool busy = false;
  String? error;
  final fields = <String, TextEditingController>{
    for (final key in [
      'capital',
      'quoteSize',
      'maxNotional',
      'maxInventory',
      'maxOpenOrders',
      'maxDailyLoss',
      'maxDrawdownPct',
      'maxVolatility',
      'maxDataAgeMs',
      'maxPriceBandBps',
      'maxFundingRate',
      'leverage',
      'lower',
      'upper',
      'levels',
      'baseSpreadBps',
      'volatilitySpreadMultiplier',
      'inventorySkewBps',
      'refreshMs',
    ])
      key: TextEditingController(),
  };
  @override
  void initState() {
    super.initState();
    setup = ref.read(strategyRepositoryProvider).setup();
    for (final entry in <String, String>{
      'maxOpenOrders': '4',
      'maxVolatility': '0.08',
      'maxDataAgeMs': '2000',
      'maxPriceBandBps': '100',
      'maxFundingRate': '0.001',
      'leverage': '1',
      'levels': '5',
      'baseSpreadBps': '20',
      'volatilitySpreadMultiplier': '100',
      'inventorySkewBps': '50',
      'refreshMs': '1000',
    }.entries) {
      fields[entry.key]!.text = entry.value;
    }
  }

  @override
  void dispose() {
    for (final field in fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  Widget number(String key, String label) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextField(
          controller: fields[key],
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
            labelText: label,
            border: const OutlineInputBorder(),
          ),
        ),
      );

  Map<String, dynamic>? values() {
    if (account == null || market == null) {
      setState(() => error = 'Choose an account and market.');
      return null;
    }
    final keys = [
      'capital',
      'quoteSize',
      'maxNotional',
      'maxInventory',
      'maxOpenOrders',
      'maxDailyLoss',
      'maxDrawdownPct',
      'maxVolatility',
      'maxDataAgeMs',
      'maxPriceBandBps',
      'maxFundingRate',
      'leverage',
    ];
    final result = <String, dynamic>{
      'kind': kind,
      'mode': mode,
      'marketId': market!.id,
      'accountId': account!.accountId,
    };
    for (final key in keys) {
      final parsed = num.tryParse(fields[key]!.text.trim());
      if (parsed == null || parsed <= 0) {
        setState(() => error = 'Enter a positive value for $key.');
        return null;
      }
      result[key] = ['maxOpenOrders', 'maxDataAgeMs'].contains(key)
          ? parsed.toInt()
          : parsed.toDouble();
    }
    if (kind == 'GRID') {
      final lower = double.tryParse(fields['lower']!.text),
          upper = double.tryParse(fields['upper']!.text);
      final levels = int.tryParse(fields['levels']!.text);
      if (lower == null ||
          upper == null ||
          lower <= 0 ||
          upper <= lower ||
          levels == null ||
          levels < 2) {
        setState(
          () => error =
              'Enter grid lower price, upper price, and at least two levels.',
        );
        return null;
      }
      result['grid'] = {'lower': lower, 'upper': upper, 'levels': levels};
    } else {
      final maker = <String, dynamic>{};
      for (final key in [
        'baseSpreadBps',
        'volatilitySpreadMultiplier',
        'inventorySkewBps',
        'refreshMs',
      ]) {
        final parsed = num.tryParse(fields[key]!.text);
        if (parsed == null || parsed < 0) {
          setState(() => error = 'Enter a valid $key.');
          return null;
        }
        maker[key] = key == 'refreshMs' ? parsed.toInt() : parsed.toDouble();
      }
      result['maker'] = maker;
    }
    return result;
  }

  Future<void> save() async {
    final config = values();
    if (config == null) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final entry = await ref
          .read(strategyRepositoryProvider)
          .create(account!.connectionId, config);
      if (mounted) {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => StrategyDashboardScreen(id: entry.id),
          ),
        );
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Set up Autopilot')),
        body: FutureBuilder<StrategySetup>(
          future: setup,
          builder: (context, snapshot) {
            if (!snapshot.hasData && !snapshot.hasError) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snapshot.hasError) {
              return const Center(
                child: Text('Setup data unavailable. Retry later.'),
              );
            }
            final data = snapshot.data!;
            if (data.accounts.isEmpty || data.markets.isEmpty) {
              return const Center(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: Text(
                    'Connect a trade-enabled Perpl account and refresh market data before setup.',
                  ),
                ),
              );
            }
            return Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Text(
                        'Step ${step + 1} of 3',
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                      const SizedBox(height: 12),
                      if (step == 0) ...[
                        DropdownButtonFormField<String>(
                          key: const Key('strategyMode'),
                          isExpanded: true,
                          initialValue: mode,
                          decoration: const InputDecoration(labelText: 'Mode'),
                          items: [
                            const DropdownMenuItem(
                              value: 'PAPER',
                              child: Text('Paper'),
                            ),
                            DropdownMenuItem(
                              value: 'LIVE',
                              enabled: data.liveEnabled,
                              child: Text(
                                data.liveEnabled
                                    ? 'Live · real orders'
                                    : 'Live · unavailable',
                              ),
                            ),
                          ],
                          onChanged: (value) => setState(() => mode = value!),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          mode == 'LIVE'
                              ? 'Creates a paused live draft. A dedicated, empty account and a reviewed start are required.'
                              : 'Paper mode. No real orders or funds are used.',
                        ),
                        if (!data.liveEnabled)
                          Text(
                            'Live unavailable: ${data.liveReason ?? 'Server live execution is disabled.'}',
                          ),
                        const SizedBox(height: 12),
                        DropdownButtonFormField<StrategyAccount>(
                          isExpanded: true,
                          initialValue: account,
                          decoration: const InputDecoration(
                            labelText: 'Perpl account',
                          ),
                          items: data.accounts
                              .map(
                                (item) => DropdownMenuItem(
                                  value: item,
                                  child: Text(
                                    '${item.environment} · Account ${item.accountId}',
                                  ),
                                ),
                              )
                              .toList(),
                          onChanged: (value) => setState(() => account = value),
                        ),
                        DropdownButtonFormField<StrategyMarket>(
                          isExpanded: true,
                          initialValue: market,
                          decoration:
                              const InputDecoration(labelText: 'Market'),
                          items: data.markets
                              .map(
                                (item) => DropdownMenuItem(
                                  value: item,
                                  child: Text('${item.symbol} · ${item.id}'),
                                ),
                              )
                              .toList(),
                          onChanged: (value) => setState(() => market = value),
                        ),
                        DropdownButtonFormField<String>(
                          isExpanded: true,
                          initialValue: kind,
                          decoration:
                              const InputDecoration(labelText: 'Strategy'),
                          items: const [
                            DropdownMenuItem(
                                value: 'GRID', child: Text('Grid')),
                            DropdownMenuItem(
                              value: 'MARKET_MAKER',
                              child: Text('Inventory-aware market maker'),
                            ),
                          ],
                          onChanged: (value) => setState(() => kind = value!),
                        ),
                        if (kind == 'GRID') ...[
                          number('lower', 'Lower price'),
                          number('upper', 'Upper price'),
                          number('levels', 'Rungs'),
                        ] else ...[
                          number('baseSpreadBps', 'Base spread (bps)'),
                          number(
                            'volatilitySpreadMultiplier',
                            'Volatility spread factor',
                          ),
                          number('inventorySkewBps', 'Inventory skew (bps)'),
                          number('refreshMs', 'Quote refresh (ms)'),
                        ],
                      ],
                      if (step == 1) ...[
                        number('capital', 'Strategy capital'),
                        number('quoteSize', 'Size per quote'),
                        number('maxNotional', 'Maximum notional'),
                        number('maxInventory', 'Maximum inventory'),
                        number('maxOpenOrders', 'Maximum open orders'),
                        number('leverage', 'Leverage'),
                      ],
                      if (step == 2) ...[
                        number('maxDailyLoss', 'Daily loss stop'),
                        number('maxDrawdownPct', 'Maximum drawdown (%)'),
                        number('maxVolatility', 'Volatility breaker'),
                        number('maxDataAgeMs', 'Stale data limit (ms)'),
                        number('maxPriceBandBps', 'Mark/oracle band (bps)'),
                        number('maxFundingRate', 'Funding guard'),
                      ],
                      if (error != null)
                        Text(
                          error!,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.error,
                          ),
                        ),
                    ],
                  ),
                ),
                SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        if (step > 0)
                          TextButton(
                            onPressed:
                                busy ? null : () => setState(() => step--),
                            child: const Text('Back'),
                          ),
                        const Spacer(),
                        FilledButton(
                          onPressed: busy
                              ? null
                              : step == 2
                                  ? save
                                  : () => setState(() => step++),
                          child: Text(
                            step == 2
                                ? mode == 'LIVE'
                                    ? 'Create live draft'
                                    : 'Create paper strategy'
                                : 'Next',
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      );
}

class StrategyDashboardScreen extends ConsumerStatefulWidget {
  const StrategyDashboardScreen({super.key, required this.id});
  final String id;
  @override
  ConsumerState<StrategyDashboardScreen> createState() =>
      _StrategyDashboardScreenState();
}

class _StrategyDashboardScreenState
    extends ConsumerState<StrategyDashboardScreen> {
  late Future<List<dynamic>> data;
  bool busy = false;
  bool livePolling = false;
  Timer? refreshTimer;
  String? error;
  @override
  void initState() {
    super.initState();
    refresh();
    refreshTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      if (mounted && livePolling && !busy) refresh();
    });
  }

  @override
  void dispose() {
    refreshTimer?.cancel();
    super.dispose();
  }

  void refresh() {
    final repo = ref.read(strategyRepositoryProvider);
    setState(() {
      data = Future.wait([
        repo.status(widget.id),
        repo.pnl(widget.id),
        repo.orders(widget.id),
        repo.fills(widget.id),
        repo.riskEvents(widget.id),
        repo.verifiedAccounting(widget.id),
      ]);
    });
  }

  Future<void> control(String action) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await ref.read(strategyRepositoryProvider).control(widget.id, action);
      refresh();
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> reviewLive(Map<String, dynamic> status) async {
    setState(() {
      busy = true;
      error = null;
    });
    final started = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => StrategyLiveReviewSheet(
        id: widget.id,
        status: status,
        repository: ref.read(strategyRepositoryProvider),
      ),
    );
    if (mounted) {
      setState(() => busy = false);
      if (started == true) refresh();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Autopilot dashboard'),
          actions: [
            IconButton(
              onPressed: refresh,
              tooltip: 'Refresh dashboard',
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: FutureBuilder<List<dynamic>>(
          future: data,
          builder: (context, snapshot) {
            if (!snapshot.hasData && !snapshot.hasError) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snapshot.hasError) {
              return const Center(
                child: Text('Dashboard unavailable. Refresh to retry.'),
              );
            }
            final status = snapshot.data![0] as Map<String, dynamic>;
            final pnl = snapshot.data![1] as Map<String, dynamic>;
            final orders = snapshot.data![2] as List<Map<String, dynamic>>;
            final fills = snapshot.data![3] as List<Map<String, dynamic>>;
            final risks = snapshot.data![4] as List<Map<String, dynamic>>;
            final accounting = snapshot.data![5] as List<StrategyAccountingRow>;
            final mode = status['mode'] as String;
            final cleanupPending = status['cleanupPending'] == true;
            livePolling = mode == 'LIVE' &&
                (status['status'] == 'RUNNING' || cleanupPending);
            final state = status['state'] as Map<String, dynamic>;
            final liveState = (status['liveState'] as Map?) ?? const {};
            final liveObservation =
                (status['liveObservation'] as Map?) ?? const {};
            final limits = (status['limits'] as Map?) ?? const {};
            return Center(
                child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 960),
                    child: ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        Text(
                          '$mode · ${status['status']}',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        if (mode != 'LIVE')
                          const Text(
                              'Simulation only. No on-chain orders or fills.'),
                        if (mode == 'LIVE') ...[
                          const Text(
                            'Real orders. Returns and loss limits are not guaranteed.',
                          ),
                          if (status['liveEnabled'] != true)
                            Text(
                              'Live unavailable: ${status['liveReason'] ?? 'Server live execution is disabled.'}',
                            ),
                          if (status['liveExpiresAt'] != null)
                            Text('Run ends (UTC): ${status['liveExpiresAt']}'),
                          if (cleanupPending)
                            const Text(
                              'Order cleanup pending. Cancellation is not yet verified.',
                              key: Key('strategyCleanupPending'),
                            ),
                          const Text(
                            'Pause, stop and risk halts cancel strategy-owned orders. Open positions remain exposed until you close them manually.',
                          ),
                        ],
                        Text(
                          '${status['environment'] ?? 'Environment unavailable'} · Account ${status['accountId'] ?? 'Unavailable'} · Market ${status['marketId'] ?? 'Unavailable'}',
                        ),
                        Text(
                            'Allocated capital: ${status['capital'] ?? 'Unavailable'}'),
                        Text(
                          'Maximum notional ${limits['maxNotional'] ?? 'Unavailable'} · Maximum inventory ${limits['maxInventory'] ?? 'Unavailable'}',
                        ),
                        Text(
                          'Maximum daily loss ${limits['maxDailyLoss'] ?? 'Unavailable'} · Maximum drawdown ${limits['maxDrawdownPct'] ?? 'Unavailable'}%',
                        ),
                        Text(
                          'Maximum open orders ${limits['maxOpenOrders'] ?? 'Unavailable'} · Leverage ${limits['leverage'] ?? 'Unavailable'}',
                        ),
                        const SizedBox(height: 12),
                        if (mode != 'LIVE')
                          Card(
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text('PnL: ${pnl['pnl'] ?? 'Unavailable'}'),
                                  Text(
                                      'Equity: ${pnl['equity'] ?? 'Unavailable'}'),
                                  Text('Inventory: ${pnl['inventory']}'),
                                  Text(
                                    'Fees paid: ${pnl['feesPaid']} · Funding paid: ${pnl['fundingPaid']}',
                                  ),
                                  Text(
                                    'Risk: ${(state['riskEvents'] as List?)?.join(', ') ?? 'No events'}',
                                  ),
                                ],
                              ),
                            ),
                          ),
                        if (mode == 'LIVE')
                          Card(
                            child: Padding(
                              padding: const EdgeInsets.all(12),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Account baseline equity: ${liveState['baselineEquity'] ?? 'Unavailable'}',
                                  ),
                                  Text(
                                    'Account peak equity: ${liveState['peakEquity'] ?? 'Unavailable'}',
                                  ),
                                  Text(
                                    'Last observed account equity: ${liveObservation['accountEquity'] ?? 'Unavailable'}',
                                  ),
                                  Text(
                                    'Account equity change: ${liveObservation['accountEquityChange'] ?? 'Unavailable'}',
                                  ),
                                  Text(
                                    'Last observed inventory: ${liveObservation['inventory'] ?? 'Unavailable'}',
                                  ),
                                  if (liveObservation['observedAt'] != null)
                                    Text(
                                      '${liveObservation['source']} · ${liveObservation['observedAt']} UTC',
                                    ),
                                  const Text(
                                    'Net realized PnL unavailable until fees, funding and settlement are fully attributed.',
                                  ),
                                ],
                              ),
                            ),
                          ),
                        if (error != null)
                          Text(
                            error!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error),
                          ),
                        Text(
                          'Verified accounting',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        if (accounting.isEmpty)
                          const ListTile(
                            dense: true,
                            title: Text('No verified fills'),
                            subtitle: Text(
                              'Receipt and signed-history proof is required before accounting appears.',
                            ),
                          ),
                        ...accounting.take(5).map(
                              (row) => ListTile(
                                dense: true,
                                title: Text(
                                    'Market ${row.marketId} · ${row.environment}'),
                                subtitle: Text(
                                  'Size ${row.positionSize} · Entry ${row.averageEntry ?? '—'} · Realized ${row.realizedPnl}',
                                ),
                                trailing: Text('Fees ${row.feesPaid}'),
                              ),
                            ),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            if (status['status'] == 'PAUSED' ||
                                (mode == 'LIVE' &&
                                    status['status'] == 'HALTED'))
                              FilledButton(
                                onPressed: busy ||
                                        (mode == 'LIVE' &&
                                            (cleanupPending ||
                                                status['liveEnabled'] != true ||
                                                status['killed'] == true))
                                    ? null
                                    : mode == 'LIVE'
                                        ? () => reviewLive(status)
                                        : () => control('start'),
                                child: Text(mode == 'LIVE'
                                    ? 'Review live start'
                                    : 'Start'),
                              ),
                            if (status['status'] == 'RUNNING')
                              OutlinedButton(
                                onPressed: busy ? null : () => control('pause'),
                                child: const Text('Pause'),
                              ),
                            if (status['status'] != 'STOPPED')
                              TextButton(
                                onPressed: busy ? null : () => control('stop'),
                                child: const Text('Stop'),
                              ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Text(
                          'Open orders (${orders.where((row) => row['status'] == 'OPEN' || row['status'] == 'PARTIAL').length})',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        ...orders.take(5).map(
                              (row) => ListTile(
                                dense: true,
                                title: Text(
                                  '${row['side'] ?? row['kind']} · ${row['status']}',
                                ),
                                subtitle: Text(
                                  '${row['size'] ?? ''} at ${row['price'] ?? ''} · ${row['simulated'] == true ? 'Simulated' : 'Venue'}',
                                ),
                              ),
                            ),
                        Text(
                          'Fills (${fills.length})',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        ...fills.take(5).map(
                              (row) => ListTile(
                                dense: true,
                                title: Text(
                                  '${row['side']} · ${row['size']} at ${row['price']}',
                                ),
                                subtitle: Text(
                                  row['simulated'] == true
                                      ? 'Simulated fill'
                                      : '${row['transaction_hash'] ?? 'Verification pending'}',
                                ),
                              ),
                            ),
                        Text(
                          'Risk events (${risks.length})',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        ...risks.take(5).map(
                              (row) => ListTile(
                                dense: true,
                                title: Text(row['code'].toString()),
                              ),
                            ),
                        if (mode == 'LIVE') ...[
                          const SizedBox(height: 16),
                          StrategyEvidencePanel(
                              id: widget.id,
                              repository: ref.read(strategyRepositoryProvider)),
                        ],
                      ],
                    )));
          },
        ),
      );
}

class StrategyEvidencePanel extends StatefulWidget {
  const StrategyEvidencePanel(
      {super.key, required this.id, required this.repository});
  final String id;
  final StrategyRepository repository;
  @override
  State<StrategyEvidencePanel> createState() => _StrategyEvidencePanelState();
}

class _StrategyEvidencePanelState extends State<StrategyEvidencePanel> {
  final publications = <StrategyPublication>[];
  late DateTime from;
  late DateTime to;
  bool acknowledged = false;
  bool busy = false;
  String? error;

  @override
  void initState() {
    super.initState();
    resetWindow();
    load();
  }

  void resetWindow() {
    to = DateTime.now().toUtc();
    from = to.subtract(const Duration(hours: 24));
    acknowledged = false;
  }

  Future<void> load() async {
    try {
      final rows = await widget.repository.publications(widget.id);
      if (mounted) {
        setState(() {
          publications.clear();
          publications.addAll(rows);
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = 'Saved reports unavailable: $e');
    }
  }

  Future<void> publish() async {
    if (!acknowledged) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final row = await widget.repository.publishEvidence(widget.id, from, to);
      if (mounted) {
        setState(() {
          publications.insert(0, row);
          acknowledged = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> revoke(StrategyPublication row) async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.repository.revokePublication(row.id);
      if (mounted) {
        setState(() => publications.removeWhere((value) => value.id == row.id));
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Submission evidence',
                  style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              const Text(
                  'Publish a saved report with a public link for judges. Only stored, verified activity is labeled as on-chain evidence.'),
              Text(
                  'Report window (UTC):\n${from.toIso8601String()}\n${to.toIso8601String()}'),
              const Text(
                  'Publishes account and strategy IDs, markets, transaction links, fill amounts, fees, risk events and code version. Anyone with the link can read it until revoked.'),
              const Text(
                  'Net realized PnL remains unavailable when funding or settlement attribution is incomplete. A report does not prove profitability.'),
              CheckboxListTile(
                key: const Key('strategyEvidenceAcknowledgment'),
                value: acknowledged,
                onChanged: busy
                    ? null
                    : (value) => setState(() => acknowledged = value ?? false),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                title: const Text(
                    'I approve publishing this report window and these account details.'),
              ),
              Wrap(spacing: 8, runSpacing: 8, children: [
                FilledButton(
                    key: const Key('strategyPublishEvidence'),
                    onPressed: busy || !acknowledged ? null : publish,
                    child: const Text('Publish last 24 hours')),
                TextButton(
                    onPressed: busy ? null : () => setState(resetWindow),
                    child: const Text('Refresh window')),
              ]),
              if (error != null)
                Text(error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              ...publications.take(5).map((row) => Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SelectableText(row.url),
                          Wrap(spacing: 8, runSpacing: 8, children: [
                            OutlinedButton(
                                onPressed: () async {
                                  await Clipboard.setData(
                                      ClipboardData(text: row.url));
                                  if (context.mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                        const SnackBar(
                                            content:
                                                Text('Public link copied')));
                                  }
                                },
                                child: const Text('Copy public link')),
                            TextButton(
                                onPressed: busy ? null : () => revoke(row),
                                child: const Text('Revoke link')),
                          ]),
                        ]),
                  )),
            ],
          ),
        ),
      );
}

class StrategyLiveReviewSheet extends StatefulWidget {
  const StrategyLiveReviewSheet({
    super.key,
    required this.id,
    required this.status,
    required this.repository,
  });
  final String id;
  final Map<String, dynamic> status;
  final StrategyRepository repository;

  @override
  State<StrategyLiveReviewSheet> createState() =>
      _StrategyLiveReviewSheetState();
}

class _StrategyLiveReviewSheetState extends State<StrategyLiveReviewSheet> {
  final duration = TextEditingController(text: '15');
  Map<String, dynamic>? preview;
  String? error;
  String? idempotencyKey;
  bool acknowledged = false;
  bool busy = false;
  bool confirmationAttempted = false;
  Timer? clock;

  @override
  void initState() {
    super.initState();
    clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && preview != null) setState(() {});
    });
  }

  @override
  void dispose() {
    clock?.cancel();
    duration.dispose();
    super.dispose();
  }

  int get remainingSeconds {
    final expiry = DateTime.tryParse(preview?['expiresAt']?.toString() ?? '');
    if (expiry == null) return 0;
    return (expiry.toUtc().difference(DateTime.now().toUtc()).inMilliseconds /
            1000)
        .ceil();
  }

  Future<void> review() async {
    final minutes = int.tryParse(duration.text.trim());
    if (minutes == null || minutes < 1 || minutes > 1440) {
      setState(
        () => error = 'Choose a whole number of minutes from 1 to 1440.',
      );
      return;
    }
    setState(() {
      busy = true;
      error = null;
      acknowledged = false;
      preview = null;
    });
    try {
      final result = await widget.repository.livePreview(
        widget.id,
        minutes * 60000,
      );
      if (mounted) {
        setState(() {
          preview = result;
          idempotencyKey = strategyIdempotencyKey();
          confirmationAttempted = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> confirm() async {
    if (!acknowledged ||
        preview?['ready'] != true ||
        preview?['previewId'] is! String) {
      return;
    }
    setState(() {
      busy = true;
      error = null;
      confirmationAttempted = true;
    });
    try {
      await widget.repository.confirmLive(
        widget.id,
        preview!['previewId'] as String,
        idempotencyKey!,
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        setState(
          () => error =
              '$e\nCheck dashboard status if the request was interrupted. A retry uses the same consent key.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final reviewed = preview ?? widget.status;
    final config = (preview?['config'] as Map?) ??
        (widget.status['limits'] as Map?) ??
        const {};
    final reasons = (preview?['reasons'] as List?) ?? const [];
    final canConfirm = preview?['ready'] == true &&
        preview?['previewId'] is String &&
        acknowledged &&
        (remainingSeconds > 0 || confirmationAttempted) &&
        !busy;
    final theme = Theme.of(context);
    return Theme(
      data: theme.copyWith(
        textTheme: theme.textTheme.apply(fontFamily: 'monospace'),
      ),
      child: Align(
        alignment: Alignment.bottomCenter,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 640,
            maxHeight: MediaQuery.sizeOf(context).height * 0.9,
          ),
          child: Material(
            color: const Color(0xFF0B0C0A),
            child: SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(
                16,
                20,
                16,
                20 + MediaQuery.viewInsetsOf(context).bottom,
              ),
              child: DefaultTextStyle(
                style: const TextStyle(
                  color: Colors.white,
                  fontFamily: 'monospace',
                  fontSize: 14,
                  height: 1.4,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Review live start',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'Real money is at risk. Loss limits trigger order cancellation; they do not guarantee a maximum loss.',
                      style: TextStyle(color: Color(0xFFFFB800)),
                    ),
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        border: Border.all(color: const Color(0xFF444444)),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Environment: ${reviewed['environment'] ?? 'Unavailable'}',
                          ),
                          Text(
                            'Account: ${reviewed['accountId'] ?? 'Unavailable'} · Market: ${reviewed['marketId'] ?? 'Unavailable'}',
                          ),
                          Text(
                            'Capital: ${reviewed['capital'] ?? 'Unavailable'} AUSD',
                          ),
                          Text(
                            'Daily loss trigger: ${config['maxDailyLoss'] ?? 'Unavailable'} AUSD',
                          ),
                          Text(
                            'Drawdown trigger: ${config['maxDrawdownPct'] ?? 'Unavailable'}%',
                          ),
                          Text(
                            'Maximum notional: ${config['maxNotional'] ?? 'Unavailable'}',
                          ),
                          Text(
                            'Maximum inventory: ${config['maxInventory'] ?? 'Unavailable'}',
                          ),
                          Text(
                            'Maximum orders: ${config['maxOpenOrders'] ?? 'Unavailable'} · Leverage: ${config['leverage'] ?? 'Unavailable'}',
                          ),
                          Text(
                              'Data age guard: ${config['maxDataAgeMs'] ?? 'Unavailable'} ms'),
                          Text(
                              'Mark/oracle guard: ${config['maxPriceBandBps'] ?? 'Unavailable'} bps'),
                          Text(
                              'Volatility guard: ${config['maxVolatility'] ?? 'Unavailable'}'),
                          Text(
                              'Funding guard: ${config['maxFundingRate'] ?? 'Unavailable'}'),
                          if (preview != null)
                            Text(
                              'Reviewed run: ${(preview!['maxRunMs'] as num) ~/ 60000} minutes',
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      key: const Key('strategyRunMinutes'),
                      controller: duration,
                      enabled: !busy,
                      keyboardType: TextInputType.number,
                      style: const TextStyle(color: Colors.white),
                      decoration: const InputDecoration(
                        labelText: 'Run duration (minutes)',
                        labelStyle: TextStyle(color: Colors.white70),
                        border: OutlineInputBorder(),
                      ),
                      onChanged: (_) => setState(() {
                        preview = null;
                        acknowledged = false;
                      }),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'A dedicated, empty account is required. Pause, stop and risk halts leave open positions exposed. Close positions manually when needed.',
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton(
                      onPressed: busy ? null : review,
                      child: Text(
                        preview == null
                            ? 'Review account and limits'
                            : 'Refresh review',
                      ),
                    ),
                    if (preview != null && preview!['ready'] != true) ...[
                      const Text(
                        'Live start unavailable',
                        style: TextStyle(color: Color(0xFFFFB800)),
                      ),
                      ...reasons.map((reason) => Text(reason.toString())),
                    ],
                    if (preview?['ready'] == true) ...[
                      Text(
                        remainingSeconds > 0
                            ? 'Review expires in $remainingSeconds seconds.'
                            : 'Review expired. Refresh before a new start.',
                      ),
                      CheckboxListTile(
                        key: const Key('strategyLiveAcknowledgment'),
                        contentPadding: EdgeInsets.zero,
                        controlAffinity: ListTileControlAffinity.leading,
                        value: acknowledged,
                        onChanged: busy
                            ? null
                            : (value) =>
                                setState(() => acknowledged = value ?? false),
                        title: const Text(
                          'I approve real orders with this account, capital, risk limits and run duration.',
                          style: TextStyle(
                            color: Colors.white,
                            fontFamily: 'monospace',
                          ),
                        ),
                      ),
                      FilledButton(
                        key: const Key('strategyConfirmLive'),
                        onPressed: canConfirm ? confirm : null,
                        child: Text(
                          confirmationAttempted
                              ? 'Retry confirmed start'
                              : 'Confirm live start',
                        ),
                      ),
                    ],
                    if (error != null)
                      Text(
                        error!,
                        style: const TextStyle(color: Color(0xFFFFB800)),
                      ),
                    TextButton(
                      onPressed:
                          busy ? null : () => Navigator.of(context).pop(false),
                      child: const Text('Cancel'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
