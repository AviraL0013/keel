import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/eyeler_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/eyeler_widgets.dart';
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
              padding: const EdgeInsets.fromLTRB(EyelerSpacing.md, EyelerSpacing.sm,
                  EyelerSpacing.md, EyelerSpacing.xl),
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
                                        style: EyelerTypography.display),
                                    const SizedBox(height: EyelerSpacing.xs),
                                    Text(
                                        '${dashboard.book.side.toLowerCase()} position',
                                        style: EyelerTypography.body.copyWith(
                                            color: Theme.of(context)
                                                .textTheme
                                                .bodyMedium
                                                ?.color))
                                  ])),
                              const SizedBox(width: EyelerSpacing.sm),
                              StatusPill(
                                  label: summary.label,
                                  color: summary.color,
                                  icon: summary.icon),
                            ]),
                        const SizedBox(height: EyelerSpacing.md),
                        Card(
                            child: Padding(
                                padding: const EdgeInsets.all(EyelerSpacing.lg),
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(summary.message,
                                          style: EyelerTypography.body),
                                      if (dashboard.telemetry.riskReason
                                                  ?.isNotEmpty ==
                                              true &&
                                          const {
                                            'Needs attention',
                                            'Checking status',
                                            'Review position'
                                          }.contains(summary.label)) ...[
                                        const SizedBox(height: EyelerSpacing.sm),
                                        Text(dashboard.telemetry.riskReason!,
                                            style: EyelerTypography.body),
                                      ],
                                    ]))),
                        const SizedBox(height: EyelerSpacing.md),
                        if (dashboard.book.status != 'CLOSED') ...[
                          BookMetricsCard(
                              book: dashboard.book,
                              telemetry: dashboard.telemetry,
                              includeTechnical: false),
                          const SizedBox(height: EyelerSpacing.md),
                        ],
                        _ExecutionCard(state: dashboard.telemetry),
                        const SizedBox(height: EyelerSpacing.md),
                        if (action.isLoading) const LinearProgressIndicator(),
                        if (action.hasError)
                          Padding(
                              padding:
                                  const EdgeInsets.only(bottom: EyelerSpacing.md),
                              child: Text(friendlyError(action.error!),
                                  style:
                                      const TextStyle(color: EyelerColors.exit))),
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
                          const SizedBox(height: EyelerSpacing.md),
                          _ControlCard(
                              book: dashboard.book,
                              disabled: action.isLoading,
                              onArm: () => _armAutomation(context, ref,
                                  dashboard.book, dashboard.telemetry),
                              onControl: (control) =>
                                  _confirmControl(context, ref, control)),
                          const SizedBox(height: EyelerSpacing.md),
                        ],
                        Card(
                            child: ExpansionTile(
                                title: const Text('More details',
                                    style: EyelerTypography.section),
                                children: [
                              Padding(
                                  padding: const EdgeInsets.fromLTRB(
                                      EyelerSpacing.md,
                                      0,
                                      EyelerSpacing.md,
                                      EyelerSpacing.md),
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        TelemetryFreshness(
                                            freshness:
                                                dashboard.telemetry.freshness),
                                        const SizedBox(height: EyelerSpacing.md),
                                        RiskBanner(
                                            state:
                                                dashboard.telemetry.riskState,
                                            reasons: _reasonSentences(
                                                dashboard.telemetry)),
                                        if (dashboard.telemetry.reasonCodes
                                            .isNotEmpty) ...[
                                          const SizedBox(
                                              height: EyelerSpacing.sm),
                                          Text(
                                              'Reason codes: ${dashboard.telemetry.reasonCodes.join(' / ')}',
                                              style: EyelerTypography.body),
                                        ],
                                        if (dashboard
                                                .telemetry.executionActionId !=
                                            null) ...[
                                          const SizedBox(
                                              height: EyelerSpacing.sm),
                                          Text(
                                              'Action ID: ${dashboard.telemetry.executionActionId}',
                                              style: EyelerTypography.body),
                                        ],
                                        if (dashboard
                                                .telemetry.executionReason !=
                                            null) ...[
                                          const SizedBox(
                                              height: EyelerSpacing.sm),
                                          Text(
                                              'Execution reason: ${dashboard.telemetry.executionReason}',
                                              style: EyelerTypography.body),
                                        ],
                                        const SizedBox(height: EyelerSpacing.md),
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
                        ? 'EYELER will verify the live position, telemetry, and unresolved executions. Automation stays off. No order is submitted.'
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

  Future<void> _armAutomation(BuildContext context, WidgetRef ref,
      Book currentBook, BookTelemetry telemetry) async {
    final reserve = telemetry.reserveAvailable;
    final consented = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
              title: const Text('Arm automation?'),
              content: Text(
                  'EYELER may DEFEND using up to ${currentBook.defenseCap.toStringAsFixed(2)} AUSD per action from your ${reserve?.toStringAsFixed(2) ?? 'unavailable'} AUSD reserve. It may also place reduce-only REDUCE and EXIT orders. Use PAUSE to stop automated actions.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('CANCEL')),
                FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('ARM AUTOMATION'))
              ],
            ));
    if (consented != true || !context.mounted) return;
    await ref.read(bookActionProvider.notifier).run(book.id, 'arm');
    final error = ref.read(bookActionProvider).error;
    if (error is EyelerException &&
        error.statusCode == 409 &&
        error.message == 'KILL_SWITCH_ENGAGED' &&
        context.mounted) {
      final stance = await showDialog<String>(
          context: context,
          builder: (_) => SimpleDialog(
                title: const Text('Choose a stance'),
                children: [
                  SimpleDialogOption(
                      onPressed: () => Navigator.pop(context, 'DEFEND'),
                      child: const ListTile(
                          title: Text('DEFEND'),
                          subtitle: Text('Use the reserve within your cap.'))),
                  SimpleDialogOption(
                      onPressed: () => Navigator.pop(context, 'HARVEST'),
                      child: const ListTile(
                          title: Text('HARVEST'),
                          subtitle: Text('Do not spend the reserve.'))),
                  SimpleDialogOption(
                      onPressed: () => Navigator.pop(context, 'KILL'),
                      child: const ListTile(
                          title: Text('KILL'),
                          subtitle: Text('Never rescue. Exit when a limit breaks.'))),
                ],
              ));
      if (stance != null) {
        await ref.read(bookActionProvider.notifier).armWithStance(book.id, stance);
      }
    }
    ref.invalidate(bookDashboardProvider(book.id));
    ref.invalidate(booksProvider);
  }

  List<String> _reasonSentences(BookTelemetry state) {
    if (state.riskReason != null && state.riskReason!.isNotEmpty) {
      return [state.riskReason!];
    }
    if (state.reasons.isNotEmpty) return state.reasons;
    return state.reasonCodes
        .map((code) => switch (code) {
              'STALE_STATE' => "Telemetry is stale, so EYELER has paused action.",
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
      'UNKNOWN' => 'Checking with Perpl',
      'CONFIRMED' => 'Action completed',
      'FAILED' => 'Action failed',
      'PARTIAL' => 'Partially completed',
      'CANCELED' => 'Action canceled',
      'EXPIRED' => 'Action expired',
      _ => 'Action in progress',
    };
    return Card(
        child: Padding(
            padding: const EdgeInsets.all(EyelerSpacing.md),
            child: Row(children: [
              Icon(
                  none
                      ? Icons.hourglass_empty
                      : unknown
                          ? Icons.help_outline
                          : Icons.receipt_long_outlined,
                  color: none
                      ? EyelerColors.info
                      : unknown
                          ? EyelerColors.reduce
                          : EyelerColors.info),
              const SizedBox(width: EyelerSpacing.sm),
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    const Text('LAST ACTION', style: EyelerTypography.label),
                    const SizedBox(height: 4),
                    Text(title, style: EyelerTypography.section),
                    if (none || unknown || status == 'FAILED' || status == 'PARTIAL' ||
                        const {'QUEUED', 'VALIDATING', 'SUBMITTING', 'SUBMITTED', 'VERIFYING'}.contains(status))
                      Text(
                          status == 'FAILED' && state.executionReason != null
                              ? state.executionReason!
                              : unknown
                                  ? 'Perpl has not confirmed the outcome. EYELER is still checking and will not repeat this action.'
                                  : status == 'PARTIAL'
                                      ? 'Part of this action completed. EYELER paused further actions while checking the position.'
                                      : none
                                          ? 'No EYELER action has been submitted for this Book.'
                                          : 'EYELER is checking the result with Perpl. Do not repeat this action.',
                          style: EyelerTypography.body.copyWith(
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
      {required this.book, required this.disabled, required this.onArm, required this.onControl});
  final Book book;
  final bool disabled;
  final VoidCallback onArm;
  final void Function(String) onControl;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: const EdgeInsets.all(EyelerSpacing.md),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(
                spacing: EyelerSpacing.sm,
                runSpacing: EyelerSpacing.sm,
                children: [
                  const Text('BOOK CONTROLS', style: EyelerTypography.label),
                  StatusPill(
                      label: switch (book.status) {
                        'SAFE_MODE' => 'Safety paused',
                        'ACTIVE' => 'Active',
                        'PAUSED' => 'Paused',
                        _ => book.status,
                      },
                      color: book.status == 'ACTIVE'
                          ? EyelerColors.defend
                          : EyelerColors.reduce,
                      icon: book.status == 'ACTIVE'
                          ? Icons.play_arrow
                          : Icons.pause),
                  StatusPill(
                      label: book.automationEnabled ? 'Auto on' : 'Auto off',
                      color: book.automationEnabled
                          ? EyelerColors.defend
                          : EyelerColors.info,
                      icon: book.automationEnabled
                          ? Icons.bolt
                          : Icons.pause_circle_outline)
                ]),
            const SizedBox(height: EyelerSpacing.sm),
            Text(
                book.status == 'SAFE_MODE'
                    ? switch (book.safeModeReason) {
                        'DATA_UNAVAILABLE' || 'VENUE_UNAVAILABLE' =>
                          'Waiting for live data — automation resumes automatically.',
                        'UNRESOLVED_ACTION' =>
                          'Checking an action with Perpl — review needed.',
                        'RUNTIME_FAILURE' =>
                          'Automation stopped — review needed.',
                        _ =>
                          'Book is in safe mode. Review the current status before acting.',
                      }
                    : book.automationEnabled
                        ? 'EYELER may act within this Book policy.'
                        : book.status == 'PAUSED'
                        ? 'Book is paused. Automation is off; manual controls remain explicit.'
                            : 'Automation is off; manual controls remain explicit.',
                style: EyelerTypography.body.copyWith(
                    color: Theme.of(context).textTheme.bodyMedium?.color)),
            const SizedBox(height: EyelerSpacing.md),
            Wrap(
                spacing: EyelerSpacing.sm,
                runSpacing: EyelerSpacing.sm,
                children: [
                  if ((book.status == 'ACTIVE' || book.status == 'PAUSED') &&
                      !book.automationEnabled)
                    FilledButton.icon(
                        onPressed: disabled ? null : onArm,
                        icon: const Icon(Icons.bolt),
                        label: const Text('ARM AUTOMATION')),
                  if (book.status == 'SAFE_MODE' &&
                      book.safeModeReason != 'DATA_UNAVAILABLE' &&
                      book.safeModeReason != 'VENUE_UNAVAILABLE')
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
