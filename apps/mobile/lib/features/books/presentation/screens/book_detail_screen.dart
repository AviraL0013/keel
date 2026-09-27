import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../../data/books_repository.dart';
import '../../domain/book.dart';
import '../controllers/book_action_controller.dart';
import '../widgets/book_widgets.dart';
import '../widgets/book_summary.dart';

class BookDetailScreen extends ConsumerWidget {
  const BookDetailScreen({super.key, required this.book});
  final Book book;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final telemetry = ref.watch(bookDashboardProvider(book.id));
    final action = ref.watch(bookActionProvider);
    return Scaffold(
      appBar: AppBar(title: Text(book.market), actions: [
        IconButton(
            onPressed: () => ref.invalidate(bookDashboardProvider(book.id)),
            icon: const Icon(Icons.refresh))
      ]),
      body: telemetry.when(
        skipLoadingOnReload: true,
        skipError: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(
            message: friendlyError(error),
            onRetry: () => ref.invalidate(bookDashboardProvider(book.id))),
        data: (dashboard) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(bookDashboardProvider(book.id)),
          child: ListView(
              padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm,
                  KeelSpacing.md, KeelSpacing.xl),
              children: [
                Builder(builder: (context) {
                  final summary =
                      BookSummary.from(dashboard.book, dashboard.telemetry);
                  return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Flexible(
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                    Text(dashboard.book.market,
                                        style: KeelTypography.display),
                                    const SizedBox(height: KeelSpacing.xs),
                                    Text(
                                        '${dashboard.book.side.toLowerCase()} position',
                                        style: KeelTypography.body.copyWith(
                                            color: Theme.of(context)
                                                .textTheme
                                                .bodyMedium
                                                ?.color))
                                  ])),
                              const SizedBox(width: KeelSpacing.sm),
                              StatusPill(
                                  label: summary.label,
                                  color: summary.color,
                                  icon: summary.icon),
                            ]),
                        const SizedBox(height: KeelSpacing.md),
                        Card(
                            child: Padding(
                                padding: const EdgeInsets.all(KeelSpacing.lg),
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(summary.message,
                                          style: KeelTypography.body),
                                      if (dashboard.telemetry.riskReason
                                                  ?.isNotEmpty ==
                                              true &&
                                          const {
                                            'Needs attention',
                                            'Checking status',
                                            'Review position'
                                          }.contains(summary.label)) ...[
                                        const SizedBox(height: KeelSpacing.sm),
                                        Text(dashboard.telemetry.riskReason!,
                                            style: KeelTypography.body),
                                      ],
                                    ]))),
                        const SizedBox(height: KeelSpacing.md),
                        if (dashboard.book.status != 'CLOSED') ...[
                          BookMetricsCard(
                              book: dashboard.book,
                              telemetry: dashboard.telemetry,
                              includeTechnical: false),
                          const SizedBox(height: KeelSpacing.md),
                        ],
                        _ExecutionCard(state: dashboard.telemetry),
                        const SizedBox(height: KeelSpacing.md),
                        if (action.isLoading) const LinearProgressIndicator(),
                        if (action.hasError)
                          Padding(
                              padding:
                                  const EdgeInsets.only(bottom: KeelSpacing.md),
                              child: Text(friendlyError(action.error!),
                                  style:
                                      const TextStyle(color: KeelColors.exit))),
                        if (dashboard.book.status != 'CLOSED') ...[
                          ActionButtonRow(
                              disabled: action.isLoading ||
                                  dashboard.book.status != 'ACTIVE' ||
                                  dashboard.telemetry.stale ||
                                  dashboard.telemetry.freshnessUnknown,
                              onDefend: () => _confirmAction(
                                  context, ref, 'DEFEND', dashboard.telemetry),
                              onReduce: () => _confirmAction(
                                  context, ref, 'REDUCE', dashboard.telemetry),
                              onExit: () => _confirmAction(
                                  context, ref, 'EXIT', dashboard.telemetry)),
                          const SizedBox(height: KeelSpacing.md),
                          _ControlCard(
                              book: dashboard.book,
                              disabled: action.isLoading,
                              onControl: (control) =>
                                  _confirmControl(context, ref, control)),
                          const SizedBox(height: KeelSpacing.md),
                        ],
                        Card(
                            child: ExpansionTile(
                                title: const Text('More details',
                                    style: KeelTypography.section),
                                children: [
                              Padding(
                                  padding: const EdgeInsets.fromLTRB(
                                      KeelSpacing.md,
                                      0,
                                      KeelSpacing.md,
                                      KeelSpacing.md),
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        TelemetryFreshness(
                                            freshness:
                                                dashboard.telemetry.freshness),
                                        const SizedBox(height: KeelSpacing.md),
                                        RiskBanner(
                                            state:
                                                dashboard.telemetry.riskState,
                                            reasons: _reasonSentences(
                                                dashboard.telemetry)),
                                        if (dashboard.telemetry.reasonCodes
                                            .isNotEmpty) ...[
                                          const SizedBox(
                                              height: KeelSpacing.sm),
                                          Text(
                                              'Reason codes: ${dashboard.telemetry.reasonCodes.join(' / ')}',
                                              style: KeelTypography.body),
                                        ],
                                        if (dashboard
                                                .telemetry.executionActionId !=
                                            null) ...[
                                          const SizedBox(
                                              height: KeelSpacing.sm),
                                          Text(
                                              'Action ID: ${dashboard.telemetry.executionActionId}',
                                              style: KeelTypography.body),
                                        ],
                                        if (dashboard
                                                .telemetry.executionReason !=
                                            null) ...[
                                          const SizedBox(
                                              height: KeelSpacing.sm),
                                          Text(
                                              'Execution reason: ${dashboard.telemetry.executionReason}',
                                              style: KeelTypography.body),
                                        ],
                                        const SizedBox(height: KeelSpacing.md),
                                        BookTechnicalMetrics(
                                            telemetry: dashboard.telemetry),
                                      ]))
                            ])),
                      ]);
                }),
              ]),
        ),
      ),
    );
  }

  Future<void> _confirmAction(BuildContext context, WidgetRef ref, String kind,
      BookTelemetry state) async {
    final destructive = kind == 'EXIT';
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
                title: Text('Confirm $kind'),
                content: Text(
                    '$kind will be evaluated by the backend policy for ${book.market}. Current position: ${state.size?.toStringAsFixed(4) ?? 'Unavailable'}; reserve: ${state.reserveAvailable?.toStringAsFixed(2) ?? 'Unavailable'}. ${destructive ? 'This can close exposure.' : 'The venue outcome will be reconciled before it is shown as complete.'}'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('CANCEL')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: Text(destructive ? 'CONFIRM EXIT' : 'CONFIRM'))
                ]));
    if (confirmed == true) {
      ref.invalidate(bookDashboardProvider(book.id));
      await ref
          .read(bookActionProvider.notifier)
          .run(book.id, kind == 'EXIT' ? 'close' : kind.toLowerCase());
      ref.invalidate(bookDashboardProvider(book.id));
      ref.invalidate(booksProvider);
    }
  }

  Future<void> _confirmControl(
      BuildContext context, WidgetRef ref, String control) async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
                title: Text(control == 'kill'
                    ? 'Enable kill switch?'
                    : control == 'recover'
                        ? 'Recover Book for manual actions?'
                        : 'Pause automation?'),
                content: Text(control == 'kill'
                    ? 'Automation will be blocked by the backend until recovery is explicit.'
                    : control == 'recover'
                        ? 'KEEL will verify the live position, telemetry, and unresolved executions. Automation stays off. No order is submitted.'
                        : 'This Book will stop automated actions.'),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('CANCEL')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: Text(control == 'kill'
                          ? 'ENABLE KILL SWITCH'
                          : control == 'recover'
                              ? 'RECOVER'
                              : 'CONFIRM'))
                ]));
    if (confirmed == true) {
      await ref.read(bookActionProvider.notifier).run(book.id, control);
      ref.invalidate(bookDashboardProvider(book.id));
      ref.invalidate(booksProvider);
    }
  }

  List<String> _reasonSentences(BookTelemetry state) {
    if (state.riskReason != null && state.riskReason!.isNotEmpty) {
      return [state.riskReason!];
    }
    if (state.reasons.isNotEmpty) return state.reasons;
    return state.reasonCodes
        .map((code) => switch (code) {
              'STALE_STATE' => "Telemetry is stale, so KEEL has paused action.",
              'AUTOMATION_PAUSED' => 'Automation is paused for this Book.',
              'TIME_LIMIT' => 'The Book time limit has been reached.',
              'USER_KILL' => 'The kill stance forbids further rescue.',
              'WITHIN_LIMITS' =>
                'All Book constraints remain inside their configured limits.',
              'VOL_SPIKE' => 'Volatility is above the configured risk regime.',
              'DEFENSE_REFUSED' =>
                'A further defense was refused by the deterministic safety policy.',
              _ =>
                'The backend returned a safety constraint for this decision.',
            })
        .toList();
  }
}

class _ExecutionCard extends StatelessWidget {
  const _ExecutionCard({required this.state});
  final BookTelemetry state;
  @override
  Widget build(BuildContext context) {
    final status = state.executionState ?? 'UNKNOWN';
    final unknown = status == 'UNKNOWN';
    final none = status == 'NO_ACTIVE_EXECUTION';
    final title = switch (status) {
      'NO_ACTIVE_EXECUTION' => 'No action in progress',
      'UNKNOWN' => 'Checking last action',
      'CONFIRMED' => 'Action completed',
      'FAILED' => 'Action failed',
      'PARTIAL' => 'Partially completed',
      'CANCELED' => 'Action canceled',
      'EXPIRED' => 'Action expired',
      _ => 'Action in progress',
    };
    return Card(
        child: Padding(
            padding: const EdgeInsets.all(KeelSpacing.md),
            child: Row(children: [
              Icon(
                  none
                      ? Icons.hourglass_empty
                      : unknown
                          ? Icons.help_outline
                          : Icons.receipt_long_outlined,
                  color: none
                      ? KeelColors.info
                      : unknown
                          ? KeelColors.reduce
                          : KeelColors.info),
              const SizedBox(width: KeelSpacing.sm),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    const Text('LAST ACTION', style: KeelTypography.label),
                    const SizedBox(height: 4),
                    Text(title, style: KeelTypography.section),
                    if (none ||
                        unknown ||
                        status == 'FAILED' ||
                        status == 'PARTIAL')
                      Text(
                          status == 'FAILED' && state.executionReason != null
                              ? state.executionReason!
                              : unknown || status == 'PARTIAL'
                                  ? 'The venue outcome is not fully confirmed. Do not repeat this action yet.'
                                  : 'No KEEL action has been submitted for this Book.',
                          style: KeelTypography.body.copyWith(
                              color: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.color))
                  ]))
            ])));
  }
}

class _ControlCard extends StatelessWidget {
  const _ControlCard(
      {required this.book, required this.disabled, required this.onControl});
  final Book book;
  final bool disabled;
  final void Function(String) onControl;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: const EdgeInsets.all(KeelSpacing.md),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(
                spacing: KeelSpacing.sm,
                runSpacing: KeelSpacing.sm,
                children: [
                  const Text('BOOK CONTROLS', style: KeelTypography.label),
                  StatusPill(
                      label: switch (book.status) {
                        'SAFE_MODE' => 'Safety paused',
                        'ACTIVE' => 'Active',
                        'PAUSED' => 'Paused',
                        _ => book.status,
                      },
                      color: book.status == 'ACTIVE'
                          ? KeelColors.defend
                          : KeelColors.reduce,
                      icon: book.status == 'ACTIVE'
                          ? Icons.play_arrow
                          : Icons.pause),
                  StatusPill(
                      label: book.automationEnabled ? 'Auto on' : 'Auto off',
                      color: book.automationEnabled
                          ? KeelColors.defend
                          : KeelColors.info,
                      icon: book.automationEnabled
                          ? Icons.bolt
                          : Icons.pause_circle_outline)
                ]),
            const SizedBox(height: KeelSpacing.sm),
            Text(
                book.automationEnabled
                    ? 'KEEL may act within this Book policy.'
                    : book.status == 'PAUSED'
                        ? 'Book is paused. Automation is off; manual controls remain explicit.'
                        : book.status == 'SAFE_MODE'
                            ? 'Book is in safe mode. Recover manual access after backend checks; automation stays off.'
                            : 'Automation is off; manual controls remain explicit.',
                style: KeelTypography.body.copyWith(
                    color: Theme.of(context).textTheme.bodyMedium?.color)),
            const SizedBox(height: KeelSpacing.md),
            Wrap(
                spacing: KeelSpacing.sm,
                runSpacing: KeelSpacing.sm,
                children: [
                  if (book.status == 'SAFE_MODE')
                    OutlinedButton.icon(
                        onPressed: disabled ? null : () => onControl('recover'),
                        icon: const Icon(Icons.health_and_safety_outlined),
                        label: const Text('RESTORE MANUAL ACTIONS')),
                  OutlinedButton.icon(
                      onPressed: disabled ? null : () => onControl('pause'),
                      icon: const Icon(Icons.pause),
                      label: const Text('PAUSE')),
                  OutlinedButton.icon(
                      onPressed: disabled ? null : () => onControl('kill'),
                      icon: const Icon(Icons.lock_outline),
                      label: const Text('KILL SWITCH'))
                ])
          ])));
}
