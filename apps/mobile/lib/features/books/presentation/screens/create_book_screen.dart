import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/books_repository.dart';
import '../../domain/book.dart';
import '../../../positions/domain/position.dart';
import '../../../capital/data/capital_repository.dart';
import '../../../../core/errors/keel_exception.dart';

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

  @override
  void dispose() {
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
        timeLimit: Duration(minutes: ((double.tryParse(hours.text) ?? double.nan) * 60).round()),
        stance: stance,
        automation: automation,
      );

  void review() {
    final config = readConfig();
    final validation = config.validate();
    setState(() => error = validation);
    if (validation == null) {
      Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => BookReviewScreen(position: widget.position, config: config),
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
              title: Text(widget.position.market),
              subtitle: Text(
                '${widget.position.side} / size ${widget.position.size} / entry ${widget.position.entryPrice} / mark ${widget.position.markPrice} / ${widget.position.status}',
              ),
            ),
          ),
          TextField(controller: floor, decoration: const InputDecoration(labelText: 'Liquidation floor')),
          const SizedBox(height: 12),
          TextField(controller: cap, decoration: const InputDecoration(labelText: 'Defense cap')),
          const SizedBox(height: 12),
          TextField(controller: reserve, decoration: const InputDecoration(labelText: 'Reserve')),
          const SizedBox(height: 12),
          TextField(controller: hours, decoration: const InputDecoration(labelText: 'Time limit in hours')),
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
          if (error != null)
            Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          const SizedBox(height: 12),
          FilledButton(onPressed: review, child: const Text('Review Book')),
        ],
      ),
    );
  }
}

class BookReviewScreen extends ConsumerWidget {
  const BookReviewScreen({super.key, required this.position, required this.config});

  final Position position;
  final BookConfiguration config;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Review Book')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Selected position', style: Theme.of(context).textTheme.titleLarge),
          Text(
            '${position.market} / ${position.side} / size ${position.size} / entry ${position.entryPrice} / mark ${position.markPrice} / ${position.status}',
          ),
          const SizedBox(height: 16),
          Text('Risk limits', style: Theme.of(context).textTheme.titleLarge),
          Text(
            'Floor ${config.liquidationFloor} / cap ${config.defenseCap} / reserve ${config.reserve} / ${config.timeLimit.inHours}h / ${config.stance} / automation ${config.automation ? 'on' : 'off'}',
          ),
          const SizedBox(height: 16),
          _CapitalPreview(snapshot: ref.watch(capitalProvider)),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: () async {
              try {
                await ref.read(booksRepositoryProvider).create(position, config);
                if (context.mounted) {
                  ref.invalidate(booksProvider);
                  Navigator.of(context).popUntil((route) => route.isFirst);
                }
              } catch (error) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Book creation failed: ${friendlyError(error)}')),
                  );
                }
              }
            },
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
  Widget build(BuildContext context) => Card(child: Padding(padding: const EdgeInsets.all(16), child: snapshot.when(loading: () => const LinearProgressIndicator(), error: (error, _) => Text(friendlyError(error)), data: (value) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text('CAPITAL CONTEXT', style: Theme.of(context).textTheme.labelLarge), const SizedBox(height: 8), Text('AUSD wallet: ${_value(value.ausdBalance)}'), Text('Perpl available: ${_value(value.perplAvailable)}'), Text('Perpl locked: ${_value(value.perplLocked)}'), const SizedBox(height: 4), const Text('Wallet balance and Perpl collateral are shown separately.')]))));
  String _value(Object? value) => value == null ? '—' : '$value';
}
