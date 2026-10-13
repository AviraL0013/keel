import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'status_models.dart';
import 'status_repository.dart';

const _background = Color(0xFF0B0C0A);
const _border = Color(0xFF363934);
const _muted = Color(0xFFB1B5AC);
const _signal = Color(0xFF00E676);

/// Read-only, sign-in-free evidence. This screen cannot start or stop trading.
class StatusScreen extends ConsumerStatefulWidget {
  const StatusScreen({super.key});
  @override
  ConsumerState<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends ConsumerState<StatusScreen> {
  StatusReport? _report;
  bool _loading = false;
  bool _paused = false;
  bool _failed = false;
  final _incidentHistory = <String, RunIncident>{};
  bool _historyLoaded = false;
  bool _historyLoading = false;
  bool _historyFailed = false;
  String? _nextIncidentCursor;
  int? _incidentTotal;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _refresh();
    _poll = Timer.periodic(const Duration(seconds: 15), (_) {
      if (!_paused) _refresh();
    });
  }

  Future<void> _refresh() async {
    if (_loading) return;
    setState(() => _loading = true);
    try {
      final report = await ref.read(statusRepositoryProvider).load();
      if (mounted) {
        setState(() {
          _report = report;
          _failed = false;
        });
        if (!_historyLoaded &&
            !_historyLoading &&
            report.run.startedAt != null) {
          await _loadIncidentPage();
        }
      }
    } catch (_) {
      // Never expose response bodies, transport errors or credentials.
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadIncidentPage({bool restart = false}) async {
    if (_historyLoading) return;
    setState(() => _historyLoading = true);
    try {
      final page = await ref
          .read(statusRepositoryProvider)
          .loadIncidentPage(cursor: restart ? null : _nextIncidentCursor);
      if (!mounted) return;
      setState(() {
        if (restart) _incidentHistory.clear();
        for (final incident in page.incidents) {
          final key = incident.id ??
              '${incident.kind}:${incident.scope}:${incident.detectedAt}';
          _incidentHistory[key] = incident;
        }
        _incidentTotal = page.total;
        _nextIncidentCursor = page.nextCursor;
        _historyLoaded = true;
        _historyFailed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _historyFailed = true);
    } finally {
      if (mounted) setState(() => _historyLoading = false);
    }
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = ThemeData.dark().copyWith(
      scaffoldBackgroundColor: _background,
      colorScheme: const ColorScheme.dark(
        primary: _signal,
        surface: _background,
        onSurface: Colors.white,
        outline: _border,
      ),
      textTheme: ThemeData.dark().textTheme.apply(
            fontFamily: 'monospace',
            bodyColor: Colors.white,
            displayColor: Colors.white,
          ),
    );
    return Theme(
      data: theme,
      child: Scaffold(
        body: SafeArea(
          child: SingleChildScrollView(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1280),
                child: Padding(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 16,
                        runSpacing: 12,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          const Text(
                            '7-day run report',
                            style: TextStyle(
                              fontSize: 26,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          OutlinedButton.icon(
                            onPressed: _loading ? null : _refresh,
                            icon: const Icon(Icons.refresh, size: 18),
                            label: const Text('Refresh'),
                          ),
                          TextButton.icon(
                            onPressed: () => setState(() => _paused = !_paused),
                            icon: Icon(
                              _paused ? Icons.play_arrow : Icons.pause,
                              size: 18,
                            ),
                            label: Text(
                              _paused ? 'Resume updates' : 'Pause updates',
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Eyeler · Public reliability evidence',
                        style: TextStyle(color: _muted),
                      ),
                      const SizedBox(height: 20),
                      if (_failed)
                        const _Notice(
                          'Report could not be refreshed. Last received values remain visible; they do not confirm current health.',
                        ),
                      if (_report == null) ...[
                        if (_loading) const LinearProgressIndicator(),
                        const SizedBox(height: 12),
                        _Notice(
                          _failed
                              ? 'Public telemetry is unavailable. Retry without signing in.'
                              : 'Loading public telemetry.',
                        ),
                      ] else
                        ..._body(_report!),
                      const SizedBox(height: 20),
                      const Text(
                        'UTC timestamps · Updates every 15 seconds · Unknown telemetry is never treated as success.',
                        style: TextStyle(color: _muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _body(StatusReport report) => [
        _Panel(
          title: 'Run window',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${_label(report.run.status)} · ${_label(report.run.environment)}',
                style: const TextStyle(fontSize: 20, color: _signal),
              ),
              const SizedBox(height: 8),
              Text('Started: ${_time(report.run.startedAt)}'),
              Text('Ends: ${_time(report.run.endsAt)}'),
              Text(
                'Report observed: ${_time(report.observedAt)}',
                style: const TextStyle(color: _muted),
              ),
              const SizedBox(height: 8),
              const Text(
                'Mainnet observation covers existing Book automation. Autopilot figures are paper-mode simulation.',
                style: TextStyle(color: _muted),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _Metrics(
          items: [
            (
              'Observed uptime',
              report.availability.uptimePercent == null
                  ? 'Unavailable'
                  : '${report.availability.uptimePercent!.toStringAsFixed(2)}%',
              'Observed: ${_durationSeconds(report.availability.observedSeconds)} · Unobserved: ${_durationSeconds(report.availability.unobservedSeconds)}',
            ),
            (
              'Worker tick age',
              _durationMs(report.availability.workerTickAgeMs),
              'Heartbeat: ${_time(report.availability.lastHeartbeatAt)}',
            ),
            (
              'Lock ownership',
              _boolLabel(
                report.availability.lockOwned,
                yes: 'Held',
                no: 'Not held',
              ),
              '${_count(report.availability.handovers)} handovers',
            ),
            (
              'Perpl WebSocket',
              _boolLabel(
                report.availability.websocketAvailable,
                yes: 'Observed',
                no: 'No observations',
              ),
              '${_count(report.availability.disconnects)} disconnects · ${_count(report.availability.reconnects)} reconnects',
            ),
          ],
        ),
        const SizedBox(height: 24),
        _Panel(
          title: 'Books',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Armed: ${_count(report.books.armedCount)} · Duplicate actions: ${_count(report.books.duplicateActions)}',
              ),
              const SizedBox(height: 16),
              const Text(
                'Decisions',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              if (report.books.decisions.isEmpty)
                const _Empty('No Book decisions recorded in this report.'),
              for (final decision in report.books.decisions)
                _Event(
                  title:
                      '${_label(decision.kind)} · ${_label(decision.status)}',
                  lines: [
                    _time(decision.at),
                    if (decision.reasonCodes.isNotEmpty)
                      decision.reasonCodes.map(_label).join(' · '),
                  ],
                ),
              const SizedBox(height: 12),
              const Text('Actions',
                  style: TextStyle(fontWeight: FontWeight.w700)),
              if (report.books.actions.isEmpty)
                const _Empty('No Book actions recorded in this report.'),
              for (final action in report.books.actions)
                _Event(
                  title: '${_label(action.kind)} · ${_label(action.status)}',
                  lines: [_time(action.at)],
                  trailing: action.explorerUrl == null
                      ? null
                      : TextButton.icon(
                          onPressed: () => _open(action.explorerUrl!),
                          icon: const Icon(Icons.open_in_new, size: 16),
                          label: const Text('Explorer'),
                        ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _Panel(
          title: 'Paper Autopilot',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Running: ${_count(report.paper.runningCount)} · Simulated orders: ${_count(report.paper.simulatedOrders)} · Simulated fills: ${_count(report.paper.simulatedFills)}',
              ),
              const SizedBox(height: 8),
              const Text(
                'Simulation only. No on-chain orders or fills.',
                style: TextStyle(color: _muted),
              ),
              for (final stat in report.paper.stats)
                _Event(
                  title: stat.label,
                  lines: [stat.value],
                ),
              if (report.paper.stats.isEmpty)
                const _Empty('Per-strategy statistics have not been reported.'),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _Panel(
          title: 'Analytics indexing',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (report.analytics.label != null) Text(report.analytics.label!),
              Text(
                'Indexed block: ${_count(report.analytics.indexedBlock)} · Confirmed head: ${_count(report.analytics.confirmedHead)}',
              ),
              Text('Lag: ${_count(report.analytics.lagBlocks)} blocks'),
              Text(
                'Verified days: ${_count(report.analytics.verifiedDays)} / ${_count(report.analytics.requestedDays)}',
              ),
              Text(
                'Coverage: ${_time(report.analytics.from)} to ${_time(report.analytics.through)}',
              ),
              Text(
                'History verified: ${_boolLabel(report.analytics.historyVerified, yes: 'Yes', no: 'No')}',
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        _Panel(
          title: 'Alerts',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                  'Telegram configured: ${_boolLabel(report.alertsConfigured, yes: 'Yes', no: 'No')}'),
              Text(
                  'Linked recipients: ${_count(report.linkedAlertRecipients)}'),
              const SizedBox(height: 8),
              const Text(
                  'Alert configuration does not prove delivery. Recovery evidence appears in the incident timeline.',
                  style: TextStyle(color: _muted)),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _Panel(
          title: 'Incident timeline',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(report.totalIncidents == null
                  ? 'Incident preview: ${report.incidents.length} rows. Total count not reported.'
                  : 'Incident preview: ${report.incidents.length} of ${report.totalIncidents} recorded incidents.'),
              if (report.incidentPreviewTruncated == true)
                const Text(
                    'This preview is limited. Full incident history below loads every page.',
                    style: TextStyle(color: _muted)),
              if (report.incidents.isEmpty)
                const _Empty(
                  'No incidents were supplied in this preview. This alone does not prove uninterrupted observation.',
                ),
              for (final incident in report.incidents)
                _Event(
                  title:
                      '${_label(incident.kind)} · ${_label(incident.status)}',
                  lines: [
                    incident.summary,
                    'Scope: ${_label(incident.scope)}',
                    'Detected: ${_time(incident.detectedAt)}',
                    'Recovered: ${_time(incident.recoveredAt)} · Recovery: ${_durationMs(incident.durationMs)}',
                  ],
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _Panel(
          title: 'Full incident history',
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
                'Loaded ${_incidentHistory.length} of ${_count(_incidentTotal)} incidents.'),
            const SizedBox(height: 8),
            const Text(
                'Ascending detection time. Load remaining pages for the complete recorded history. Refresh to include later incidents and recovery updates.',
                style: TextStyle(color: _muted)),
            if (_historyFailed)
              const _Notice(
                  'Incident history could not be refreshed. Previously loaded rows remain visible; retry to obtain the remaining history.'),
            if (!_historyLoaded && !_historyLoading && !_historyFailed)
              const _Empty(
                  'The run has not started. Incident history is unavailable.'),
            if (_historyLoading)
              const Padding(
                  padding: EdgeInsets.symmetric(vertical: 12),
                  child: LinearProgressIndicator()),
            for (final incident in _incidentHistory.values)
              _Event(
                  title:
                      '${_label(incident.kind)} · ${_label(incident.status)}',
                  lines: [
                    incident.summary,
                    'Scope: ${_label(incident.scope)}',
                    'Detected: ${_time(incident.detectedAt)}',
                    'Recovered: ${_time(incident.recoveredAt)} · Recovery: ${_durationMs(incident.durationMs)}'
                  ]),
            if (_nextIncidentCursor != null || _historyFailed)
              OutlinedButton(
                  onPressed: _historyLoading ? null : () => _loadIncidentPage(),
                  child: Text(_historyFailed
                      ? 'Retry incident history'
                      : 'Load more incidents')),
            if (_historyLoaded &&
                _nextIncidentCursor == null &&
                !_historyLoading)
              TextButton.icon(
                  onPressed: () => _loadIncidentPage(restart: true),
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Refresh incident history')),
          ]),
        ),
        const SizedBox(height: 16),
        _Panel(
          title: 'Failure testing',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Sandbox or test venue only. Individual results establish only the listed invariants.',
                style: TextStyle(color: _muted),
              ),
              if (report.chaos.isEmpty)
                const _Empty('No failure-test results recorded yet.'),
              for (final result in report.chaos)
                _Event(
                  title:
                      '${_label(result.scenario)} · ${_label(result.status)}',
                  lines: [
                    _time(result.at),
                    'Recovery: ${_durationMs(result.recoveryMs)}',
                  ],
                  content: Wrap(
                    spacing: 18,
                    runSpacing: 8,
                    children: [
                      _Invariant(
                          'No duplicate orders', result.noDuplicateOrders),
                      _Invariant(
                        'No UNKNOWN resubmission',
                        result.noUnknownResubmission,
                      ),
                      _Invariant(
                        'No PARTIAL resubmission',
                        result.noPartialResubmission,
                      ),
                      _Invariant('Fail closed', result.failClosed),
                    ],
                  ),
                ),
            ],
          ),
        ),
        if (report.limitations.isNotEmpty) ...[
          const SizedBox(height: 16),
          _Panel(
            title: 'Evidence limits',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final limitation in report.limitations)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child:
                        Text(limitation, style: const TextStyle(color: _muted)),
                  ),
              ],
            ),
          ),
        ],
      ];

  Future<void> _open(Uri uri) async {
    var launched = false;
    try {
      launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // Platform errors are not part of public telemetry.
    }
    if (!launched && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Explorer could not be opened.')),
      );
    }
  }
}

class _Metrics extends StatelessWidget {
  const _Metrics({required this.items});
  final List<(String, String, String)> items;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, constraints) {
          final columns = constraints.maxWidth >= 1000
              ? 4
              : constraints.maxWidth >= 650
                  ? 2
                  : 1;
          final width = (constraints.maxWidth - (columns - 1) * 12) / columns;
          return Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (final item in items)
                SizedBox(
                  width: width,
                  child: _Panel(
                    title: item.$1,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          item.$2,
                          style: const TextStyle(
                            fontSize: 26,
                            fontWeight: FontWeight.w700,
                            fontFeatures: [FontFeature.tabularFigures()],
                          ),
                        ),
                        const SizedBox(height: 10),
                        Text(
                          item.$3,
                          style: const TextStyle(fontSize: 12, color: _muted),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          );
        },
      );
}

class _Panel extends StatelessWidget {
  const _Panel({required this.title, required this.child});
  final String title;
  final Widget child;
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(border: Border.all(color: _border)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(color: _muted, fontSize: 14)),
            const SizedBox(height: 14),
            child,
          ],
        ),
      );
}

class _Event extends StatelessWidget {
  const _Event({
    required this.title,
    required this.lines,
    this.trailing,
    this.content,
  });
  final String title;
  final List<String> lines;
  final Widget? trailing, content;
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: const BoxDecoration(
          border: Border(bottom: BorderSide(color: _border)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
            for (final line in lines)
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Text(
                  line,
                  style: const TextStyle(color: _muted, fontSize: 12),
                ),
              ),
            if (content != null)
              Padding(padding: const EdgeInsets.only(top: 12), child: content!),
            if (trailing != null) trailing!,
          ],
        ),
      );
}

class _Invariant extends StatelessWidget {
  const _Invariant(this.label, this.value);
  final String label;
  final bool? value;
  String get verdict => value == null
      ? 'Unavailable'
      : value!
          ? 'Passed'
          : 'Failed';
  @override
  Widget build(BuildContext context) => Semantics(
        label: '$label: $verdict',
        child: Text(
          '$label: $verdict',
          style:
              TextStyle(fontSize: 12, color: value == true ? _signal : _muted),
        ),
      );
}

class _Empty extends StatelessWidget {
  const _Empty(this.message);
  final String message;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child:
            Text(message, style: const TextStyle(color: _muted, fontSize: 13)),
      );
}

class _Notice extends StatelessWidget {
  const _Notice(this.message);
  final String message;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Semantics(
          liveRegion: true,
          child: Text(message, style: const TextStyle(color: _muted)),
        ),
      );
}

String _time(DateTime? value) =>
    value == null ? 'Not reported' : '${value.toUtc().toIso8601String()} UTC';
String _label(String value) => value.replaceAll('_', ' ');
String _count(int? value) => value?.toString() ?? 'Not reported';
String _boolLabel(bool? value, {required String yes, required String no}) =>
    value == null
        ? 'Not reported'
        : value
            ? yes
            : no;
String _durationMs(num? value) => value == null
    ? 'Unavailable'
    : value == 0
        ? '0ms'
        : value < 1
            ? '<1ms'
            : value < 1000
                ? '${value.toStringAsFixed(1)}ms'
                : '${(value / 1000).toStringAsFixed(1)}s';
String _durationSeconds(int? value) => value == null
    ? 'Not reported'
    : value >= 3600
        ? '${(value / 3600).toStringAsFixed(2)}h'
        : '${value}s';
