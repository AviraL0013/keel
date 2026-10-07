import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/errors/eyeler_exception.dart';
import '../../../core/theme/app_theme.dart';
import '../../books/presentation/screens/create_book_screen.dart';
import '../../positions/data/positions_repository.dart';
import '../../positions/domain/position.dart';
import '../data/opening_repository.dart';

class OpeningScreen extends ConsumerStatefulWidget {
  const OpeningScreen({super.key});
  @override
  ConsumerState<OpeningScreen> createState() => _OpeningScreenState();
}

class _OpeningScreenState extends ConsumerState<OpeningScreen> {
  late Future<List<OpeningMarket>> markets;
  @override
  void initState() {
    super.initState();
    markets = ref.read(openingRepositoryProvider).listMarkets();
  }

  void reload() => setState(() {
        markets = ref.read(openingRepositoryProvider).listMarkets();
      });
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Open a position'), actions: [
          IconButton(
              onPressed: reload,
              icon: const Icon(Icons.refresh),
              tooltip: 'Refresh markets')
        ]),
        body: FutureBuilder<List<OpeningMarket>>(
            future: markets,
            builder: (context, snapshot) {
              if (!snapshot.hasData && !snapshot.hasError) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snapshot.hasError) {
                return Center(
                    child: Padding(
                        padding: const EdgeInsets.all(16),
                        child:
                            Column(mainAxisSize: MainAxisSize.min, children: [
                          Text(friendlyError(snapshot.error!)),
                          const SizedBox(height: 12),
                          OutlinedButton(
                              onPressed: reload, child: const Text('Retry'))
                        ])));
              }
              final rows = snapshot.data!
                  .where((market) => market.status == 'OPEN')
                  .toList();
              if (rows.isEmpty) {
                return const Center(child: Text('No tradable markets'));
              }
              return ListView(
                  padding: const EdgeInsets.all(EyelerSpacing.md),
                  children: [
                    const Text('Choose a market',
                        style: EyelerTypography.title),
                    const SizedBox(height: EyelerSpacing.md),
                    ...rows.map((market) => Card(
                        child: ListTile(
                            title: Text(market.symbol),
                            subtitle:
                                Text('Market ${market.id} · ${market.status}'),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => Navigator.of(context).push(
                                MaterialPageRoute<void>(
                                    builder: (_) =>
                                        OpeningOrderScreen(market: market)))))),
                  ]);
            }),
      );
}

class OpeningOrderScreen extends ConsumerStatefulWidget {
  const OpeningOrderScreen({super.key, required this.market});
  final OpeningMarket market;
  @override
  ConsumerState<OpeningOrderScreen> createState() => _OpeningOrderScreenState();
}

class _OpeningOrderScreenState extends ConsumerState<OpeningOrderScreen> {
  final size = TextEditingController(), leverage = TextEditingController();
  String side = 'LONG';
  int slippageBps = 50;
  bool busy = false;
  String? error;
  late Future<Map<String, dynamic>> snapshot;
  @override
  void initState() {
    super.initState();
    snapshot = ref.read(openingRepositoryProvider).snapshot(widget.market.id);
  }

  @override
  void dispose() {
    size.dispose();
    leverage.dispose();
    super.dispose();
  }

  String? price(Map<String, dynamic> data, String key) {
    final raw = data[key], decimals = data['priceDecimals'];
    if (raw is! int || decimals is! int || decimals < 0 || decimals > 18) {
      return null;
    }
    final scale = BigInt.from(10).pow(decimals);
    final value = BigInt.from(raw);
    if (decimals == 0) return value.toString();
    return '${value ~/ scale}.${(value % scale).toString().padLeft(decimals, '0')}';
  }

  Future<void> preview() async {
    if (busy) return;
    bool refresh = false;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await ref.read(openingRepositoryProvider).preview(
          widget.market.id,
          side,
          size.text.trim(),
          leverage.text.trim(),
          slippageBps);
      if (!mounted) return;
      refresh = await showModalBottomSheet<bool>(
              context: context,
              isScrollControlled: true,
              builder: (_) => _OpeningPreviewSheet(
                  preview: result,
                  onStale: () => Navigator.of(context).pop(true))) ??
          false;
    } catch (failure) {
      if (mounted) setState(() => error = friendlyError(failure));
    } finally {
      if (mounted) setState(() => busy = false);
    }
    if (refresh && mounted) unawaited(preview());
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('Open ${widget.market.symbol}')),
        body: ListView(
            padding: const EdgeInsets.all(EyelerSpacing.md),
            children: [
              Text(widget.market.symbol, style: EyelerTypography.display),
              const SizedBox(height: EyelerSpacing.md),
              FutureBuilder<Map<String, dynamic>>(
                  future: snapshot,
                  builder: (context, value) {
                    if (!value.hasData && !value.hasError) {
                      return const LinearProgressIndicator();
                    }
                    if (value.hasError) {
                      return Text(friendlyError(value.error!));
                    }
                    final bid = price(value.data!, 'bidRaw'),
                        ask = price(value.data!, 'askRaw');
                    return Text(
                        'Best bid ${bid ?? 'Unavailable'} · Best ask ${ask ?? 'Unavailable'}');
                  }),
              const SizedBox(height: EyelerSpacing.lg),
              SegmentedButton<String>(
                  segments: const [
                    ButtonSegment(value: 'LONG', label: Text('Long')),
                    ButtonSegment(value: 'SHORT', label: Text('Short'))
                  ],
                  selected: {
                    side
                  },
                  onSelectionChanged: busy
                      ? null
                      : (value) => setState(() => side = value.first)),
              const SizedBox(height: EyelerSpacing.md),
              TextField(
                  controller: size,
                  onChanged: (_) => setState(() {}),
                  enabled: !busy,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                      labelText: 'Exact size', hintText: '0.001')),
              const SizedBox(height: EyelerSpacing.md),
              TextField(
                  controller: leverage,
                  onChanged: (_) => setState(() {}),
                  enabled: !busy,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(
                      labelText: 'Leverage', hintText: '5.00')),
              const SizedBox(height: EyelerSpacing.md),
              DropdownButtonFormField<int>(
                  initialValue: slippageBps,
                  decoration:
                      const InputDecoration(labelText: 'Maximum slippage'),
                  items: const [25, 50, 100, 200]
                      .map((value) => DropdownMenuItem(
                          value: value, child: Text('$value bps')))
                      .toList(),
                  onChanged: busy
                      ? null
                      : (value) {
                          if (value != null) {
                            setState(() => slippageBps = value);
                          }
                        }),
              const SizedBox(height: EyelerSpacing.md),
              if (error != null)
                Text(error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              FilledButton(
                  onPressed: busy ||
                          size.text.trim().isEmpty ||
                          leverage.text.trim().isEmpty
                      ? null
                      : preview,
                  child: Text(busy ? 'Checking…' : 'Preview order')),
            ]),
      );
}

class _OpeningPreviewSheet extends ConsumerStatefulWidget {
  const _OpeningPreviewSheet({required this.preview, required this.onStale});
  final OpeningPreview preview;
  final VoidCallback onStale;
  @override
  ConsumerState<_OpeningPreviewSheet> createState() =>
      _OpeningPreviewSheetState();
}

class _OpeningPreviewSheetState extends ConsumerState<_OpeningPreviewSheet> {
  bool busy = false;
  String? error;
  late final String key = openingIdempotencyKey();
  Future<void> confirm() async {
    if (busy) return;
    if (DateTime.now().millisecondsSinceEpoch >= widget.preview.expiresAt) {
      widget.onStale();
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final order = await ref
          .read(openingRepositoryProvider)
          .confirm(widget.preview.id, key);
      if (!mounted) return;
      final navigator = Navigator.of(context);
      navigator.pop();
      navigator.push(MaterialPageRoute<void>(
          builder: (_) => OpeningStatusScreen(orderId: order.id)));
    } catch (failure) {
      if (!mounted) return;
      if (failure is EyelerException && failure.message == 'PREVIEW_STALE') {
        widget.onStale();
        return;
      }
      setState(() => error = friendlyError(failure));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final quote = widget.preview.quote;
    return SafeArea(
        child: Padding(
            padding: const EdgeInsets.all(EyelerSpacing.lg),
            child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Confirm opening', style: EyelerTypography.title),
                  const SizedBox(height: EyelerSpacing.md),
                  Text(
                      '${quote['environment']} · Perpl account ${widget.preview.accountId}',
                      style: EyelerTypography.section),
                  Text('Connection ${widget.preview.connectionId}',
                      maxLines: 2, overflow: TextOverflow.ellipsis),
                  const SizedBox(height: EyelerSpacing.md),
                  Text(
                      '${quote['side']} ${quote['size']} ${quote['market']} at up to ${quote['limitPrice']}'),
                  Text(
                      'Leverage ${quote['leverage']}x · Slippage ${quote['slippageBps']} bps'),
                  Text(
                      'Estimated collateral ${quote['estimatedMargin']} ${quote['collateralAsset']}'),
                  Text(
                      'Estimated fees ${quote['estimatedTradingFee']} + ${quote['recycleFee']}'),
                  Text(
                      'Estimated total ${quote['estimatedRequiredBalance']} ${quote['collateralAsset']}'),
                  const SizedBox(height: EyelerSpacing.md),
                  if (error != null)
                    Text(error!,
                        style: TextStyle(
                            color: Theme.of(context).colorScheme.error)),
                  SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                          onPressed: busy ? null : confirm,
                          child: Text(busy ? 'Submitting…' : 'Confirm order'))),
                ])));
  }
}

class OpeningStatusScreen extends ConsumerStatefulWidget {
  const OpeningStatusScreen({super.key, required this.orderId});
  final String orderId;
  @override
  ConsumerState<OpeningStatusScreen> createState() =>
      _OpeningStatusScreenState();
}

class _OpeningStatusScreenState extends ConsumerState<OpeningStatusScreen> {
  OpeningOrder? order;
  Position? position;
  String? error;
  Timer? timer;
  bool loading = false;
  @override
  void initState() {
    super.initState();
    unawaited(refresh());
    timer =
        Timer.periodic(const Duration(seconds: 2), (_) => unawaited(refresh()));
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> refresh() async {
    if (loading) return;
    loading = true;
    try {
      final next =
          await ref.read(openingRepositoryProvider).order(widget.orderId);
      Position? verified;
      if (['CONFIRMED', 'PARTIAL'].contains(next.status) &&
          next.positionId != null) {
        final positions = await ref.read(positionsRepositoryProvider).list();
        for (final item in positions) {
          if (item.accountId == next.accountId &&
              item.marketId == next.marketId &&
              item.positionId == next.positionId &&
              item.status == 'OPEN') {
            verified = item;
            break;
          }
        }
      }
      if (mounted) {
        setState(() {
          order = next;
          position = verified;
          error = null;
        });
      }
      if (['CONFIRMED', 'PARTIAL', 'FAILED'].contains(next.status) &&
          verified != null) {
        timer?.cancel();
      }
    } catch (failure) {
      if (mounted) setState(() => error = friendlyError(failure));
    } finally {
      loading = false;
    }
  }

  String? explorerUrl(String? hash) {
    const base = String.fromEnvironment('EYELER_MONAD_EXPLORER_URL');
    final uri = Uri.tryParse(base);
    if (hash == null ||
        !RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(hash) ||
        uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty) {
      return null;
    }
    return '${base.replaceFirst(RegExp(r'/$'), '')}/tx/$hash';
  }

  @override
  Widget build(BuildContext context) {
    final value = order, verified = position;
    return Scaffold(
        appBar: AppBar(title: const Text('Order status'), actions: [
          IconButton(
              onPressed: refresh,
              icon: const Icon(Icons.refresh),
              tooltip: 'Refresh order')
        ]),
        body: ListView(
            padding: const EdgeInsets.all(EyelerSpacing.md),
            children: [
              if (value == null && error == null)
                const Center(child: CircularProgressIndicator()),
              if (error != null)
                Text(error!,
                    style:
                        TextStyle(color: Theme.of(context).colorScheme.error)),
              if (value != null) ...[
                Text(value.status, style: EyelerTypography.display),
                Text('${value.environment} · Perpl account ${value.accountId}'),
                Text('${value.side} · Market ${value.marketId}'),
                if (value.filledSize != null)
                  Text('Filled size ${value.filledSize}'),
                if (value.averagePrice != null)
                  Text('Average price ${value.averagePrice}'),
                if (value.error != null) Text(value.error!),
                if (value.txHash != null)
                  SelectableText('Transaction ${value.txHash}'),
                if (explorerUrl(value.txHash) case final link?)
                  TextButton.icon(
                      onPressed: () =>
                          Clipboard.setData(ClipboardData(text: link)),
                      icon: const Icon(Icons.copy),
                      label: const Text('Copy explorer link')),
                const SizedBox(height: EyelerSpacing.md),
                if (verified != null) ...[
                  Text('Verified position ${verified.positionId}',
                      style: EyelerTypography.title),
                  Text(
                      '${verified.market} ${verified.side} · Size ${verified.size}'),
                  Text(
                      'Entry ${verified.entryPrice} · Liquidation ${verified.liquidationPrice}'),
                  FilledButton(
                      onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                              builder: (_) =>
                                  CreateBookScreen(position: verified))),
                      child: const Text('Protect this position')),
                ] else if (['CONFIRMED', 'PARTIAL'].contains(value.status))
                  const Text(
                      'Waiting for verified current position. Refresh to check again.'),
                if (value.status == 'UNKNOWN')
                  const Text(
                      'Outcome unverified. Do not submit another order for this account.'),
              ],
            ]));
  }
}
