import 'package:flutter/material.dart';
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
              'Paper strategies use live Perpl data. Orders and fills are simulated.',
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
                      'Stops all your strategies and clears simulated quotes.',
                    ),
                    const SizedBox(height: 8),
                    FilledButton.icon(
                      onPressed: busy || killed ? null : kill,
                      icon: const Icon(Icons.stop_circle_outlined),
                      label: const Text('Stop all strategies'),
                    ),
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
                    'No strategies yet. Create a paper strategy to evaluate risk limits.',
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
              label: const Text('Set up paper strategy'),
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
      'mode': 'PAPER',
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
                        const Text(
                            'Paper mode. No real orders or funds are used.'),
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
                              step == 2 ? 'Create paper strategy' : 'Next'),
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
  String? error;
  @override
  void initState() {
    super.initState();
    refresh();
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
            final state = status['state'] as Map<String, dynamic>;
            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(
                  '$mode · ${status['status']}',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                if (mode != 'LIVE')
                  const Text('Simulation only. No on-chain orders or fills.'),
                const SizedBox(height: 12),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('PnL: ${pnl['pnl'] ?? 'Unavailable'}'),
                        Text('Equity: ${pnl['equity'] ?? 'Unavailable'}'),
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
                if (error != null)
                  Text(
                    error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error),
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
                        title:
                            Text('Market ${row.marketId} · ${row.environment}'),
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
                    if (status['status'] == 'PAUSED')
                      FilledButton(
                        onPressed: busy ? null : () => control('start'),
                        child: const Text('Start'),
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
              ],
            );
          },
        ),
      );
}
