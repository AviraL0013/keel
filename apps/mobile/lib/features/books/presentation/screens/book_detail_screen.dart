import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../../data/books_repository.dart';
import '../../domain/book.dart';
import '../controllers/book_action_controller.dart';
import '../widgets/book_widgets.dart';

class BookDetailScreen extends ConsumerWidget {
  const BookDetailScreen({super.key, required this.book});
  final Book book;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final telemetry = ref.watch(bookTelemetryProvider(book.id));
    final action = ref.watch(bookActionProvider);
    return Scaffold(
      appBar: AppBar(title: Text(book.market), actions: [IconButton(onPressed: () => ref.invalidate(bookTelemetryProvider(book.id)), icon: const Icon(Icons.refresh))]),
      body: telemetry.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(message: friendlyError(error), onRetry: () => ref.invalidate(bookTelemetryProvider(book.id))),
        data: (state) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(bookTelemetryProvider(book.id)),
          child: ListView(padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl), children: [
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, crossAxisAlignment: CrossAxisAlignment.start, children: [Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(book.market, style: KeelTypography.display), const SizedBox(height: KeelSpacing.xs), Text('${book.side} / ${book.stance}', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color))]), RiskStateBadge(state: state.riskState)]),
            const SizedBox(height: KeelSpacing.md),
            TelemetryFreshness(freshnessMs: state.freshnessMs),
            const SizedBox(height: KeelSpacing.md),
            RiskBanner(state: state.riskState, reasons: _reasonSentences(state)),
            if (state.reasonCodes.isNotEmpty)
              Card(child: ExpansionTile(title: const Text('Technical reason codes', style: KeelTypography.label), children: [Padding(padding: const EdgeInsets.fromLTRB(KeelSpacing.md, 0, KeelSpacing.md, KeelSpacing.md), child: Align(alignment: Alignment.centerLeft, child: Text(state.reasonCodes.join(' / '))))])),
            const SizedBox(height: KeelSpacing.md),
            BookMetricsCard(book: book, telemetry: state),
            const SizedBox(height: KeelSpacing.md),
            _ExecutionCard(state: state),
            const SizedBox(height: KeelSpacing.md),
            if (action.isLoading) const LinearProgressIndicator(),
            if (action.hasError) Padding(padding: const EdgeInsets.only(bottom: KeelSpacing.md), child: Text(friendlyError(action.error!), style: const TextStyle(color: KeelColors.exit))),
            ActionButtonRow(disabled: action.isLoading, onDefend: () => _confirmAction(context, ref, 'DEFEND', state), onReduce: () => _confirmAction(context, ref, 'REDUCE', state), onExit: () => _confirmAction(context, ref, 'EXIT', state)),
            const SizedBox(height: KeelSpacing.md),
            _ControlCard(book: book, disabled: action.isLoading, onControl: (control) => _confirmControl(context, ref, control)),
          ]),
        ),
      ),
    );
  }

  Future<void> _confirmAction(BuildContext context, WidgetRef ref, String kind, BookTelemetry state) async {
    final destructive = kind == 'EXIT';
    final confirmed = await showDialog<bool>(context: context, builder: (_) => AlertDialog(title: Text('Confirm $kind'), content: Text('$kind will be evaluated by the backend policy for ${book.market}. Current position: ${state.size?.toStringAsFixed(4) ?? 'Unavailable'}; reserve: ${state.reserveAvailable?.toStringAsFixed(2) ?? 'Unavailable'}. ${destructive ? 'This can close exposure.' : 'The venue outcome will be reconciled before it is shown as complete.'}'), actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('CANCEL')), FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(destructive ? 'CONFIRM EXIT' : 'CONFIRM'))]));
    if (confirmed == true) {
      ref.invalidate(bookTelemetryProvider(book.id));
      await ref.read(bookActionProvider.notifier).run(book.id, kind == 'EXIT' ? 'close' : kind.toLowerCase());
      ref.invalidate(bookTelemetryProvider(book.id));
    }
  }

  Future<void> _confirmControl(BuildContext context, WidgetRef ref, String control) async {
    final confirmed = await showDialog<bool>(context: context, builder: (_) => AlertDialog(title: Text(control == 'kill' ? 'Enable kill switch?' : 'Pause automation?'), content: Text(control == 'kill' ? 'Automation will be blocked by the backend until recovery is explicit.' : 'This Book will stop automated actions.'), actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('CANCEL')), FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(control == 'kill' ? 'ENABLE KILL SWITCH' : 'CONFIRM'))]));
    if (confirmed == true) {
      await ref.read(bookActionProvider.notifier).run(book.id, control);
      ref.invalidate(bookTelemetryProvider(book.id));
    }
  }

  List<String> _reasonSentences(BookTelemetry state) {
    if (state.reasons.isNotEmpty) return state.reasons;
    return state.reasonCodes.map((code) => switch (code) {
      'STALE_STATE' => "Telemetry is stale, so KEEL has paused action.",
      'AUTOMATION_PAUSED' => 'Automation is paused for this Book.',
      'TIME_LIMIT' => 'The Book time limit has been reached.',
      'USER_KILL' => 'The kill stance forbids further rescue.',
      'WITHIN_LIMITS' => 'All Book constraints remain inside their configured limits.',
      'VOL_SPIKE' => 'Volatility is above the configured risk regime.',
      'DEFENSE_REFUSED' => 'A further defense was refused by the deterministic safety policy.',
      _ => 'The backend returned a safety constraint for this decision.',
    }).toList();
  }
}

class _ExecutionCard extends StatelessWidget {
  const _ExecutionCard({required this.state});
  final BookTelemetry state;
  @override
  Widget build(BuildContext context) {
    final status = state.executionState ?? 'UNKNOWN';
    final unknown = status == 'UNKNOWN';
    return Card(child: Padding(padding: const EdgeInsets.all(KeelSpacing.md), child: Row(children: [Icon(unknown ? Icons.help_outline : Icons.receipt_long_outlined, color: unknown ? KeelColors.reduce : KeelColors.info), const SizedBox(width: KeelSpacing.sm), Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [const Text('EXECUTION', style: KeelTypography.label), const SizedBox(height: 4), Text(status, style: KeelTypography.section), if (unknown) Text('Authoritative venue outcome is not established yet.', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color))]))])));
  }
}

class _ControlCard extends StatelessWidget {
  const _ControlCard({required this.book, required this.disabled, required this.onControl});
  final Book book;
  final bool disabled;
  final void Function(String) onControl;
  @override
  Widget build(BuildContext context) => Card(child: Padding(padding: const EdgeInsets.all(KeelSpacing.md), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [const Text('AUTOMATION', style: KeelTypography.label), StatusPill(label: book.automationEnabled ? 'ARMED' : 'PAUSED', color: book.automationEnabled ? KeelColors.defend : KeelColors.reduce, icon: book.automationEnabled ? Icons.play_arrow : Icons.pause)]), const SizedBox(height: KeelSpacing.sm), Text(book.automationEnabled ? 'KEEL may act within this Book policy.' : 'Automation is paused; manual controls remain explicit.', style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)), const SizedBox(height: KeelSpacing.md), Wrap(spacing: KeelSpacing.sm, runSpacing: KeelSpacing.sm, children: [OutlinedButton.icon(onPressed: disabled ? null : () => onControl('pause'), icon: const Icon(Icons.pause), label: const Text('PAUSE')), OutlinedButton.icon(onPressed: disabled ? null : () => onControl('kill'), icon: const Icon(Icons.lock_outline), label: const Text('KILL SWITCH'))])])));
}
