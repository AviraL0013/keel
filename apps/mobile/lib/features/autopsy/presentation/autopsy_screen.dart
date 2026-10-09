import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import '../../../core/errors/eyeler_exception.dart';
import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../data/autopsy_repository.dart';
import '../domain/autopsy_event.dart';

class AutopsyScreen extends ConsumerWidget {
  const AutopsyScreen({
    super.key,
    required this.bookId,
    this.explorerBaseUrl = const String.fromEnvironment(
      'EYELER_MONAD_EXPLORER_URL',
      defaultValue: String.fromEnvironment('KEEL_MONAD_EXPLORER_URL'),
    ),
  });
  final String bookId;
  final String explorerBaseUrl;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(autopsyProvider(bookId));
    return Scaffold(
      appBar: AppBar(title: const Text('Autopsy'), actions: [
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
                    'Decisions, actions, and reconciliations will appear here as EYELER operates.')
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(EyelerSpacing.md,
                    EyelerSpacing.sm, EyelerSpacing.md, EyelerSpacing.xl),
                itemCount: items.length + 1,
                itemBuilder: (_, index) => index == 0
                    ? const Padding(
                        padding: EdgeInsets.only(bottom: EyelerSpacing.lg),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Action history',
                                style: EyelerTypography.display),
                            SizedBox(height: EyelerSpacing.xs),
                            Text('Decisions and outcomes for this Book.'),
                          ],
                        ),
                      )
                    : _TimelineEvent(
                        event: items[index - 1],
                        last: index == items.length,
                        explorerBaseUrl: explorerBaseUrl)),
      ),
    );
  }
}

class _TimelineEvent extends StatelessWidget {
  const _TimelineEvent(
      {required this.event, required this.last, required this.explorerBaseUrl});
  final AutopsyEvent event;
  final bool last;
  final String explorerBaseUrl;

  @override
  Widget build(BuildContext context) {
    final style = _style(event);
    final time = DateTime.tryParse(event.timestamp);
    return IntrinsicHeight(
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(
          width: 36,
          child: Column(children: [
            EyelerIconTile(icon: style.icon, color: style.color, size: 30),
            if (!last)
              Expanded(
                  child: Container(
                      width: 2, color: style.color.withValues(alpha: .35))),
          ])),
      const SizedBox(width: EyelerSpacing.sm),
      Expanded(
          child: EyelerPanel(
              tone: style.color,
              padding: EdgeInsets.zero,
              child: Padding(
                  padding: const EdgeInsets.all(EyelerSpacing.md),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Expanded(
                                  child: Text(_summary(event),
                                      style: EyelerTypography.section)),
                              const SizedBox(width: EyelerSpacing.sm),
                              ConstrainedBox(
                                  constraints:
                                      const BoxConstraints(maxWidth: 124),
                                  child: StatusPill(
                                      label: event.type.replaceAll('_', ' '),
                                      color: style.color))
                            ]),
                        const SizedBox(height: EyelerSpacing.xs),
                        Text(
                            '${_relative(time)} / ${time == null ? event.timestamp : _absolute(time)}',
                            style: EyelerTypography.body.copyWith(
                                color: Theme.of(context)
                                    .textTheme
                                    .bodyMedium
                                    ?.color)),
                        const SizedBox(height: EyelerSpacing.sm),
                        ExpansionTile(
                            tilePadding: EdgeInsets.zero,
                            childrenPadding: EdgeInsets.zero,
                            title: const Text('Technical details',
                                style: EyelerTypography.label),
                            children: [
                              _detail('Decision', event.decision),
                              _detail('Reason', event.reason),
                              _detail('Action', event.action),
                              _detail('Venue result', event.venueResult),
                              _detail('Post-state', event.postState),
                              _detail('Reserve effect',
                                  event.reserveEffect?.toString()),
                              if (event.venueProgress case final progress?) ...[
                                _detail(
                                    'Perpl admission',
                                    progress['admitted'] == true
                                        ? 'Perpl admitted'
                                        : 'Perpl not admitted'),
                                _detail('Venue response',
                                    _text(progress['response'])),
                                _detail(
                                    'Request ID', _text(progress['requestId'])),
                                _detail(
                                    'Block',
                                    progress['effectiveLastExecBlock'] is int
                                        ? 'Block ${progress['effectiveLastExecBlock']}'
                                        : null),
                              ],
                              if (_explorerUrl() case final url?)
                                Row(children: [
                                  Expanded(
                                      child: SelectableText('Explorer: $url')),
                                  IconButton(
                                      tooltip: 'Copy explorer link',
                                      onPressed: () => Clipboard.setData(
                                          ClipboardData(text: url)),
                                      icon: const Icon(Icons.copy)),
                                ]),
                            ]),
                      ])))),
    ]));
  }

  String? _explorerUrl() {
    final base = Uri.tryParse(explorerBaseUrl);
    if (base == null ||
        base.scheme != 'https' ||
        base.host.isEmpty ||
        base.userInfo.isNotEmpty) {
      return null;
    }
    final root = explorerBaseUrl.replaceFirst(RegExp(r'/$'), '');
    final hash = event.transactionHash;
    if (hash != null && RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(hash)) {
      return '$root/tx/$hash';
    }
    final block = event.venueProgress?['effectiveLastExecBlock'];
    if (block is int && block > 0) return '$root/block/$block';
    return null;
  }

  String? _text(Object? value) => value?.toString();

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

  EyelerRiskVisual _style(AutopsyEvent value) {
    if (value.type.contains('SAFE_MODE')) {
      return EyelerRiskVisual.forState('SAFE_MODE');
    }
    if (value.type.contains('REFUSED') || value.decision == 'REDUCE') {
      return EyelerRiskVisual.forState('REDUCE');
    }
    if (value.decision == 'DEFEND') {
      return EyelerRiskVisual.forState('DEFEND');
    }
    if (value.decision == 'EXIT') {
      return EyelerRiskVisual.forState('EXIT');
    }
    return EyelerRiskVisual.forState('HOLD');
  }
}
