import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/books_repository.dart';
import '../../domain/book.dart';
import '../../../positions/domain/position.dart';
import '../../../positions/data/positions_repository.dart';
import '../../../capital/data/capital_repository.dart';
import '../../../../core/errors/keel_exception.dart';
import 'book_detail_screen.dart';

class CreateBookScreen extends ConsumerStatefulWidget {
  const CreateBookScreen({super.key, required this.position});

  final Position position;

  @override
  ConsumerState<CreateBookScreen> createState() => _CreateBookScreenState();
}

class _CreateBookScreenState extends ConsumerState<CreateBookScreen> {
  final floor = TextEditingController();
  final cap = TextEditingController();
  final reserve = TextEditingController();
  final hours = TextEditingController();
  String? stance;
  bool automation = false;
  String? error;
  late Position selectedPosition;
  Timer? telemetryTimer;
  Future<void>? positionRefresh;
  bool positionAvailable = true;
  bool positionRefreshFailed = false;
  bool get telemetryReady => selectedPosition.status == 'OPEN' && positionAvailable && !positionRefreshFailed && selectedPosition.bookCreation?.allowed == true;
  String get telemetryReason {
    if (!positionAvailable) return 'Selected Perpl position is no longer available.';
    if (positionRefreshFailed) return 'Live position and market telemetry could not be refreshed. Retry shortly.';
    return selectedPosition.bookCreation?.reason ?? 'Backend has not confirmed live telemetry readiness.';
  }

  @override
  void initState() {
    super.initState();
    selectedPosition = widget.position;
    unawaited(refreshPosition());
    telemetryTimer = Timer.periodic(const Duration(seconds: 3), (_) => unawaited(refreshPosition()));
  }

  Future<void> refreshPosition() => positionRefresh ??= _loadPosition().whenComplete(() => positionRefresh = null);

  Future<void> _loadPosition() async {
    try {
      final positions = await ref.read(positionsRepositoryProvider).list();
      final matches = positions.where((position) =>
          position.accountId == widget.position.accountId &&
          position.marketId == widget.position.marketId &&
          position.positionId == widget.position.positionId);
      if (!mounted) return;
      setState(() {
        positionAvailable = matches.isNotEmpty;
        positionRefreshFailed = false;
        if (matches.isNotEmpty) selectedPosition = matches.first;
      });
    } catch (_) {
      if (mounted) setState(() => positionRefreshFailed = true);
    }
  }

  @override
  void dispose() {
    telemetryTimer?.cancel();
    floor.dispose();
    cap.dispose();
    reserve.dispose();
    hours.dispose();
    super.dispose();
  }

  BookConfiguration readConfig() => BookConfiguration(
        liquidationFloor: double.tryParse(floor.text) ?? double.nan,
        defenseCap: double.tryParse(cap.text) ?? double.nan,
        reserve: double.tryParse(reserve.text) ?? double.nan,
        timeLimit: Duration(
            minutes:
                ((double.tryParse(hours.text) ?? double.nan) * 60).round()),
        stance: stance,
        automation: automation,
      );

  Future<void> review() async {
    final config = readConfig();
    final validation = config.validate();
    setState(() => error = validation);
    if (validation != null) return;
    await refreshPosition();
    if (!mounted) return;
    if (telemetryReady && selectedPosition.status == 'OPEN') {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) =>
              BookReviewScreen(position: selectedPosition, config: config),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Configure Book')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              title: Text(selectedPosition.market),
              subtitle: Text(
                '${selectedPosition.side} / size ${selectedPosition.size} / entry ${selectedPosition.entryPrice} / mark ${selectedPosition.markPrice} / ${selectedPosition.status}',
              ),
            ),
          ),
          TextField(
              controller: floor,
              decoration:
                  const InputDecoration(labelText: 'Liquidation floor')),
          const SizedBox(height: 12),
          TextField(
              controller: cap,
              decoration: const InputDecoration(labelText: 'Defense cap')),
          const SizedBox(height: 12),
          TextField(
              controller: reserve,
              decoration: const InputDecoration(labelText: 'Reserve')),
          const SizedBox(height: 12),
          TextField(
              controller: hours,
              decoration:
                  const InputDecoration(labelText: 'Time limit in hours')),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: stance,
            hint: const Text('Choose stance'),
            items: const [
              DropdownMenuItem(value: 'DEFEND', child: Text('DEFEND')),
              DropdownMenuItem(value: 'HARVEST', child: Text('HARVEST')),
              DropdownMenuItem(value: 'KILL', child: Text('KILL')),
            ],
            onChanged: (value) => setState(() => stance = value),
            decoration: const InputDecoration(labelText: 'Stance'),
          ),
          SwitchListTile(
            title: const Text('Automation'),
            value: automation,
            onChanged: (value) => setState(() => automation = value),
          ),
          _CapitalPreview(snapshot: ref.watch(capitalProvider)),
          if (!telemetryReady)
            const Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text('LIVE TELEMETRY REQUIRED')),
          if (!telemetryReady)
            Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(telemetryReason)),
          if (error != null)
            Text(error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error)),
          const SizedBox(height: 12),
          FilledButton(
              onPressed: telemetryReady ? review : null,
              child: const Text('Review Book')),
        ],
      ),
    );
  }
}

class BookReviewScreen extends ConsumerWidget {
  const BookReviewScreen(
      {super.key, required this.position, required this.config});

  final Position position;
  final BookConfiguration config;

  bool get telemetryReady => position.bookCreation?.allowed == true;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Review Book')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Selected position',
              style: Theme.of(context).textTheme.titleLarge),
          Text(
            '${position.market} / ${position.side} / size ${position.size} / entry ${position.entryPrice} / mark ${position.markPrice} / ${position.status}',
          ),
          const SizedBox(height: 16),
          Text('Risk limits', style: Theme.of(context).textTheme.titleLarge),
          Text(
            'Floor ${config.liquidationFloor} / cap ${config.defenseCap} / reserve ${config.reserve} / ${config.timeLimit.inHours}h / ${config.stance} / automation ${config.automation ? 'on' : 'off'}',
          ),
          if (!telemetryReady) ...[
            const SizedBox(height: 12),
            Text(position.bookCreation?.reason ?? 'Backend has not confirmed live telemetry readiness.'),
          ],
          const SizedBox(height: 16),
          _CapitalPreview(snapshot: ref.watch(capitalProvider)),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: telemetryReady
                ? () async {
                    try {
                      final created = await ref
                          .read(booksRepositoryProvider)
                          .create(position, config);
                      if (context.mounted) {
                        ref.invalidate(booksProvider);
                        Navigator.of(context).pushAndRemoveUntil(
                            MaterialPageRoute(
                                builder: (_) =>
                                    BookDetailScreen(book: created)),
                            (route) => route.isFirst);
                      }
                    } catch (error) {
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                              content: Text(
                                  'Book creation failed: ${friendlyError(error)}')),
                        );
                      }
                    }
                  }
                : null,
            child: const Text('Create Book'),
          ),
        ],
      ),
    );
  }
}

class _CapitalPreview extends StatelessWidget {
  const _CapitalPreview({required this.snapshot});
  final AsyncValue<dynamic> snapshot;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: const EdgeInsets.all(16),
          child: snapshot.when(
              loading: () => const LinearProgressIndicator(),
              error: (error, _) => Text(friendlyError(error)),
              data: (value) => Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('CAPITAL CONTEXT',
                            style: Theme.of(context).textTheme.labelLarge),
                        const SizedBox(height: 8),
                        Text('AUSD wallet: ${_value(value.walletAusd.amount)}'),
                        Text(
                            'Perpl available: ${_value(value.perplAvailable.amount)}'),
                        Text('Perpl locked: ${_value(value.perplLocked.amount)}'),
                        const SizedBox(height: 4),
                        const Text(
                            'Wallet balance and Perpl collateral are shown separately.')
                      ]))));
  String _value(Object? value) => value == null ? '—' : '$value';
}
