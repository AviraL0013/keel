import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../data/autopsy_repository.dart';
import '../domain/autopsy_event.dart';

class AutopsyScreen extends ConsumerWidget {
  const AutopsyScreen({super.key, required this.bookId});
  final String bookId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(autopsyProvider(bookId));
    return Scaffold(
      appBar: AppBar(title: const Text('AUTOPSY'), actions: [
        IconButton(
            onPressed: () => ref.invalidate(autopsyProvider(bookId)),
            icon: const Icon(Icons.refresh))
      ]),
      body: events.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(
            message: friendlyError(error),
            onRetry: () => ref.invalidate(autopsyProvider(bookId))),
        data: (items) => items.isEmpty
            ? const EmptyStateCard(
                icon: Icons.timeline_outlined,
                title: 'NO EVIDENCE YET',
                message:
                    'Decisions, actions, and reconciliations will appear here as KEEL operates.')
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(KeelSpacing.md,
                    KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl),
                itemCount: items.length,
                itemBuilder: (_, index) => _TimelineEvent(
                    event: items[index], last: index == items.length - 1)),
      ),
    );
  }
}

class _TimelineEvent extends StatelessWidget {
  const _TimelineEvent({required this.event, required this.last});
  final AutopsyEvent event;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final style = _style(event);
    final time = DateTime.tryParse(event.timestamp);
    return IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(
          width: 36,
          child: Column(children: [
            Container(
                width: 30,
                height: 30,
                decoration: BoxDecoration(
                    color: style.color.withValues(alpha: .18),
                    shape: BoxShape.circle),
                child: Icon(style.icon, size: 16, color: style.color)),
            if (!last)
              Expanded(
                  child: Container(
                      width: 2, color: style.color.withValues(alpha: .35))),
          ])),
      const SizedBox(width: KeelSpacing.sm),
      Expanded(
          child: Card(
              margin: const EdgeInsets.only(bottom: KeelSpacing.md),
              child: Padding(
                  padding: const EdgeInsets.all(KeelSpacing.md),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Expanded(
                                  child: Text(_summary(event),
                                      style: KeelTypography.section)),
                              const SizedBox(width: KeelSpacing.sm),
                              StatusPill(
                                  label: event.type.replaceAll('_', ' '),
                                  color: style.color)
                            ]),
                        const SizedBox(height: KeelSpacing.xs),
                        Text(
                            '${_relative(time)} / ${time == null ? event.timestamp : _absolute(time)}',
                            style: KeelTypography.body.copyWith(
                                color: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.color)),
                        const SizedBox(height: KeelSpacing.sm),
                        ExpansionTile(
                            tilePadding: EdgeInsets.zero,
                            childrenPadding: EdgeInsets.zero,
                            title: const Text('Technical detail',
                                style: KeelTypography.label),
                            children: [
                              _detail('Decision', event.decision),
                              _detail('Reason', event.reason),
                              _detail('Action', event.action),
                              _detail('Venue result', event.venueResult),
                              _detail('Post-state', event.postState),
                              _detail('Reserve effect',
                                  event.reserveEffect?.toString())
                            ]),
                      ])))),
    ]));
  }

  Widget _detail(String label, String? value) {
    if (value == null) return const SizedBox.shrink();
    return Padding(
        padding: const EdgeInsets.only(bottom: 5),
        child: Align(
            alignment: Alignment.centerLeft, child: Text('$label: $value')));
  }

  String _summary(AutopsyEvent value) {
    if (value.type == 'DEFENSE_REFUSED') {
      return 'Refused to defend - safety policy held the reserve.';
    }
    if (value.type == 'SAFE_MODE_ENTERED') {
      return "Paused automation - telemetry wasn't fresh enough to act safely.";
    }
    if (value.type == 'SAFE_MODE_EXITED') {
      return 'Resumed monitoring after authoritative state returned.';
    }
    if (value.type == 'DEFENSE_EFFICIENCY_UPDATED') {
      return 'Defense efficiency updated from the reconciled position.';
    }
    if (value.type == 'DECISION_CREATED') {
      return 'Risk decision recorded by the policy engine.';
    }
    if (value.action != null) {
      return '${value.action} action recorded and reconciled.';
    }
    return value.type.replaceAll('_', ' ');
  }

  String _relative(DateTime? time) {
    if (time == null) return 'time unknown';
    final delta = DateTime.now().difference(time);
    if (delta.inSeconds < 60) return '${delta.inSeconds}s ago';
    if (delta.inMinutes < 60) return '${delta.inMinutes}m ago';
    if (delta.inHours < 24) return '${delta.inHours}h ago';
    return '${delta.inDays}d ago';
  }

  String _absolute(DateTime time) {
    final local = time.toLocal();
    return '${local.year}-${local.month.toString().padLeft(2, '0')}-${local.day.toString().padLeft(2, '0')} ${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
  }

  KeelRiskVisual _style(AutopsyEvent value) {
    if (value.type.contains('SAFE_MODE')) {
      return KeelRiskVisual.forState('SAFE_MODE');
    }
    if (value.type.contains('REFUSED') || value.decision == 'REDUCE') {
      return KeelRiskVisual.forState('REDUCE');
    }
    if (value.decision == 'DEFEND') {
      return KeelRiskVisual.forState('DEFEND');
    }
    if (value.decision == 'EXIT') {
      return KeelRiskVisual.forState('EXIT');
    }
    return KeelRiskVisual.forState('HOLD');
  }
}
