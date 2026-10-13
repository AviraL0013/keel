/// Only documented public fields enter this model. Arbitrary server fields are
/// never rendered, and missing telemetry remains unknown rather than zero.
class StatusReport {
  const StatusReport({
    required this.run,
    required this.observedAt,
    required this.availability,
    required this.books,
    required this.paper,
    required this.analytics,
    required this.incidents,
    required this.chaos,
    required this.limitations,
    this.alertsConfigured,
    this.linkedAlertRecipients,
    this.totalIncidents,
    this.incidentPreviewTruncated,
  });
  final RunStatus run;
  final DateTime? observedAt;
  final RunAvailability availability;
  final BookRunStatus books;
  final PaperRunStatus paper;
  final AnalyticsRunStatus analytics;
  final List<RunIncident> incidents;
  final List<ChaosResult> chaos;
  final List<String> limitations;
  final bool? alertsConfigured;
  final int? linkedAlertRecipients;
  final int? totalIncidents;
  final bool? incidentPreviewTruncated;

  factory StatusReport.fromJson(Object? value) {
    final json = _map(value);
    if (json['version'] != 1) {
      throw const FormatException('Unsupported status report version');
    }
    return StatusReport(
      run: RunStatus.fromJson(_map(json['run'])),
      observedAt: _date(json['observedAt']),
      availability: RunAvailability.fromJson(_map(json['availability'])),
      books: BookRunStatus.fromJson(_map(json['books'])),
      paper: PaperRunStatus.fromJson(_map(json['paper'])),
      analytics: AnalyticsRunStatus.fromJson(_map(json['analytics'])),
      incidents: _list(json['incidents'], maximum: 1000)
          .map((row) => RunIncident.fromJson(_map(row)))
          .toList(),
      chaos: _list(json['chaos'], maximum: 2000)
          .map((row) => ChaosResult.fromJson(_map(row)))
          .toList(),
      limitations: _list(json['limitations'])
          .whereType<String>()
          .map(safeStatusText)
          .toList(),
      alertsConfigured: _bool(_map(json['alerts'])['configured']),
      linkedAlertRecipients: _count(_map(json['alerts'])['linkedRecipients']),
      totalIncidents: _count(json['totalIncidents']),
      incidentPreviewTruncated: _bool(json['incidentPreviewTruncated']),
    );
  }
}

class RunStatus {
  const RunStatus({
    this.startedAt,
    this.endsAt,
    this.status = 'not_started',
    this.environment = 'Not reported',
    this.durationDays,
  });
  final DateTime? startedAt;
  final DateTime? endsAt;
  final String status;
  final String environment;
  final int? durationDays;
  factory RunStatus.fromJson(Map<String, Object?> json) => RunStatus(
        startedAt: _date(json['startedAt']),
        endsAt: _date(json['endsAt']),
        status: _text(json['status']) ?? 'not_started',
        environment: _text(json['environment']) ?? 'Not reported',
        durationDays: _count(json['durationDays']),
      );
}

class RunAvailability {
  const RunAvailability({
    this.uptimePercent,
    this.observedSeconds,
    this.unobservedSeconds,
    this.lastHeartbeatAt,
    this.workerTickAgeMs,
    this.lockOwned,
    this.handovers,
    this.disconnects,
    this.reconnects,
    this.websocketAvailable,
  });
  final double? uptimePercent;
  final int? observedSeconds,
      unobservedSeconds,
      workerTickAgeMs,
      handovers,
      disconnects,
      reconnects;
  final DateTime? lastHeartbeatAt;
  final bool? lockOwned, websocketAvailable;
  factory RunAvailability.fromJson(Map<String, Object?> json) {
    final websocket = _map(json['websocket']);
    final uptime = _number(json['uptimePercent']);
    return RunAvailability(
      uptimePercent:
          uptime != null && uptime >= 0 && uptime <= 100 ? uptime : null,
      observedSeconds: _count(json['observedSeconds']),
      unobservedSeconds: _count(json['unobservedSeconds']),
      workerTickAgeMs: _count(json['workerTickAgeMs']),
      lastHeartbeatAt: _date(json['lastHeartbeatAt']),
      lockOwned: _bool(json['lockOwned']),
      handovers: _count(json['handovers']),
      disconnects: _count(websocket['disconnects']),
      reconnects: _count(websocket['reconnects']),
      websocketAvailable: _bool(websocket['available']),
    );
  }
}

class BookRunStatus {
  const BookRunStatus({
    this.armedCount,
    this.duplicateActions,
    this.decisions = const [],
    this.actions = const [],
  });
  final int? armedCount, duplicateActions;
  final List<RunDecision> decisions;
  final List<RunAction> actions;
  factory BookRunStatus.fromJson(Map<String, Object?> json) => BookRunStatus(
        armedCount: _count(json['armedCount']),
        duplicateActions: _count(json['duplicateActions']),
        decisions: _list(json['decisions'])
            .map((row) => RunDecision.fromJson(_map(row)))
            .toList(),
        actions: _list(json['actions'])
            .map((row) => RunAction.fromJson(_map(row)))
            .toList(),
      );
}

class RunDecision {
  const RunDecision({
    this.at,
    required this.kind,
    required this.status,
    this.reasonCodes = const [],
  });
  final DateTime? at;
  final String kind, status;
  final List<String> reasonCodes;
  factory RunDecision.fromJson(Map<String, Object?> json) => RunDecision(
        at: _date(json['at']),
        kind: _text(json['kind']) ?? 'Decision',
        status: _text(json['status']) ?? 'Not reported',
        reasonCodes: _list(json['reasonCodes'])
            .whereType<String>()
            .map(safeStatusText)
            .toList(),
      );
}

class RunAction {
  const RunAction({
    this.at,
    required this.kind,
    required this.status,
    this.explorerUrl,
  });
  final DateTime? at;
  final String kind, status;
  final Uri? explorerUrl;
  factory RunAction.fromJson(Map<String, Object?> json) => RunAction(
        at: _date(json['at']),
        kind: _text(json['kind']) ?? 'Action',
        status: _text(json['status']) ?? 'Not reported',
        explorerUrl: publicExplorerUrl(json['explorerUrl']),
      );
}

class PaperRunStatus {
  const PaperRunStatus({
    this.runningCount,
    this.simulatedOrders,
    this.simulatedFills,
    this.stats = const [],
  });
  final int? runningCount, simulatedOrders, simulatedFills;
  final List<PaperStat> stats;
  factory PaperRunStatus.fromJson(Map<String, Object?> json) => PaperRunStatus(
        runningCount: _count(json['runningCount']),
        simulatedOrders: _count(json['simulatedOrders']),
        simulatedFills: _count(json['simulatedFills']),
        stats: _list(json['stats'])
            .map((row) => PaperStat.fromJson(_map(row)))
            .toList(),
      );
}

class PaperStat {
  const PaperStat({
    required this.label,
    required this.value,
  });
  final String label, value;
  factory PaperStat.fromJson(Map<String, Object?> json) => PaperStat(
        label: _text(json['label']) ?? 'Paper statistic',
        value: _text(json['value']) ?? 'Not reported',
      );
}

class AnalyticsRunStatus {
  const AnalyticsRunStatus({
    this.label,
    this.from,
    this.through,
    this.indexedBlock,
    this.confirmedHead,
    this.lagBlocks,
    this.verifiedDays,
    this.requestedDays,
    this.historyVerified,
    this.rollupsEnabled,
  });
  final String? label;
  final DateTime? from, through;
  final int? indexedBlock,
      confirmedHead,
      lagBlocks,
      verifiedDays,
      requestedDays;
  final bool? historyVerified, rollupsEnabled;
  factory AnalyticsRunStatus.fromJson(Map<String, Object?> json) =>
      AnalyticsRunStatus(
        label: _text(json['label']),
        from: _date(json['from']),
        through: _date(json['through']),
        indexedBlock: _count(json['indexedBlock']),
        confirmedHead: _count(json['confirmedHead']),
        lagBlocks: _count(json['lagBlocks']),
        verifiedDays: _count(json['verifiedDays']),
        requestedDays: _count(json['requestedDays']),
        historyVerified: _bool(json['historyVerified']),
        rollupsEnabled: _bool(json['rollupsEnabled']),
      );
}

class RunIncident {
  const RunIncident({
    required this.kind,
    required this.scope,
    required this.status,
    required this.summary,
    this.detectedAt,
    this.recoveredAt,
    this.durationMs,
    this.id,
  });
  final String kind, scope, status, summary;
  final DateTime? detectedAt, recoveredAt;
  final int? durationMs;
  final String? id;
  factory RunIncident.fromJson(Map<String, Object?> json) => RunIncident(
        kind: _text(json['kind']) ?? 'Incident',
        scope: _text(json['scope']) ?? 'Not reported',
        status: _text(json['status']) ?? 'Not reported',
        summary: _text(json['summary']) ?? 'No incident detail supplied.',
        detectedAt: _date(json['detectedAt']),
        recoveredAt: _date(json['recoveredAt']),
        durationMs: _count(json['durationMs']),
        id: _text(json['id']),
      );
}

class IncidentPage {
  const IncidentPage(
      {required this.incidents, required this.nextCursor, required this.total});
  final List<RunIncident> incidents;
  final String? nextCursor;
  final int? total;
  factory IncidentPage.fromJson(Object? value) {
    final json = _map(value);
    final cursor = json['nextCursor'];
    if (cursor != null && (cursor is! String || !validIncidentCursor(cursor))) {
      throw const FormatException('Invalid incident cursor');
    }
    return IncidentPage(
      incidents: _list(json['incidents'], maximum: 100)
          .map((row) => RunIncident.fromJson(_map(row)))
          .toList(),
      nextCursor: cursor as String?,
      total: _count(json['total']),
    );
  }
}

bool validIncidentCursor(String value) =>
    value.isNotEmpty &&
    value.length <= 2048 &&
    RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(value);

class ChaosResult {
  const ChaosResult({
    required this.scenario,
    required this.status,
    this.at,
    this.recoveryMs,
    this.noDuplicateOrders,
    this.noUnknownResubmission,
    this.noPartialResubmission,
    this.failClosed,
  });
  final String scenario, status;
  final DateTime? at;
  final double? recoveryMs;
  final bool? noDuplicateOrders,
      noUnknownResubmission,
      noPartialResubmission,
      failClosed;
  factory ChaosResult.fromJson(Map<String, Object?> json) {
    final invariants = _map(json['invariants']);
    return ChaosResult(
      scenario: _text(json['scenario']) ?? 'Scenario',
      status: _text(json['status']) ?? 'Not reported',
      at: _date(json['at']),
      recoveryMs: _nonNegativeNumber(json['recoveryMs']),
      noDuplicateOrders: _bool(invariants['noDuplicateOrders']),
      noUnknownResubmission: _bool(invariants['noUnknownResubmission']),
      noPartialResubmission: _bool(invariants['noPartialResubmission']),
      failClosed: _bool(invariants['failClosed']),
    );
  }
}

Map<String, Object?> _map(Object? value) => value is Map
    ? {
        for (final entry in value.entries)
          if (entry.key is String) entry.key as String: entry.value,
      }
    : const {};
List<Object?> _list(Object? value, {int maximum = 200}) =>
    value is List ? value.take(maximum).toList() : const [];
DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value)?.toUtc() : null;
double? _number(Object? value) {
  final number = value is num
      ? value.toDouble()
      : value is String
          ? double.tryParse(value)
          : null;
  return number != null && number.isFinite ? number : null;
}

int? _count(Object? value) {
  final number = _number(value);
  return number != null && number >= 0 && number == number.truncateToDouble()
      ? number.toInt()
      : null;
}

double? _nonNegativeNumber(Object? value) {
  final number = _number(value);
  return number != null && number >= 0 ? number : null;
}

bool? _bool(Object? value) => value is bool ? value : null;
String? _text(Object? value) => value is String ? safeStatusText(value) : null;

/// Defense in depth for incidental public text. Secret fields are never parsed.
String safeStatusText(String value) {
  final redacted = value
      .replaceAll(RegExp(r'0x[a-fA-F0-9]{40,}'), '[redacted]')
      .replaceAll(RegExp(r'arn:aws:[^\s]+'), '[redacted]')
      .replaceAll(RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f]'), '');
  return redacted.substring(0, redacted.length.clamp(0, 500));
}

Uri? publicExplorerUrl(Object? value) {
  if (value is! String) return null;
  final uri = Uri.tryParse(value);
  if (uri == null ||
      uri.scheme != 'https' ||
      uri.userInfo.isNotEmpty ||
      uri.hasPort ||
      uri.hasQuery ||
      uri.hasFragment ||
      !const {
        'monadscan.com',
        'monadvision.com',
        'testnet.monadexplorer.com',
        'monadexplorer.com',
      }.contains(uri.host) ||
      !(RegExp(r'^/tx/0x[a-fA-F0-9]{64}$').hasMatch(uri.path) ||
          (uri.host == 'monadvision.com' &&
              RegExp(r'^/block/[1-9][0-9]*$').hasMatch(uri.path)))) {
    return null;
  }
  return uri;
}
