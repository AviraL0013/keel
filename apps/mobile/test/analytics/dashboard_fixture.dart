import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/features/analytics/dashboard_data.dart';

enum DashboardTestState { loading, empty, unavailable, stale, loaded }

/// Replay of public mainnet v1 responses captured on 2026-10-11. Golden tests
/// use the unmodified bodies. State tests explicitly alter availability only.
class RecordedDashboard {
  RecordedDashboard({this.state});
  final DashboardTestState? state;
  static final archive = jsonDecode(
      File('test/analytics/fixtures/mainnet-2026-10-11.json')
          .readAsStringSync()) as Map<String, dynamic>;
  static final now = DateTime.utc(2026, 10, 11, 14);
  static String get wallet => archive['wallet'] as String;
  final pending = Completer<Object?>();
  final requests = <String>[];
  late final api = DashboardApi(get, now: () => now);

  Future<Object?> get(String path) async {
    requests.add(path);
    if (state == DashboardTestState.loading) return pending.future;
    if (state == DashboardTestState.unavailable) {
      throw StateError('Recorded source unavailable');
    }
    final uri = Uri.parse(path);
    final responses = archive['responses'] as Map<String, dynamic>;
    final match = responses.entries.where((entry) {
      final recorded = Uri.parse(entry.key);
      return recorded.path == uri.path &&
          recorded.queryParameters['metric'] == uri.queryParameters['metric'] &&
          recorded.queryParameters['window'] == uri.queryParameters['window'];
    }).firstOrNull;
    if (match == null) throw StateError('No recorded response for $path');
    final stored = match.value as Map<String, dynamic>;
    if (stored['status'] != 200) {
      throw StateError('ANALYTICS_HTTP_${stored['status']}');
    }
    final json = jsonDecode(jsonEncode(stored['body'])) as Map<String, dynamic>;
    final data = json['data'] as Map<String, dynamic>;
    // Range interaction tests crop recorded observations. They never generate
    // extra observations and golden tests always request the original 30 days.
    if (data.containsKey('from') && uri.queryParameters['from'] != null) {
      data['from'] = uri.queryParameters['from'];
      data['to'] = uri.queryParameters['to'];
      final from = DateTime.parse(data['from'] as String),
          to = DateTime.parse(data['to'] as String);
      data['points'] = (data['points'] as List).where((p) {
        final at = DateTime.parse(p['time'] as String);
        return !at.isBefore(from) && at.isBefore(to);
      }).toList();
    }
    if (state == DashboardTestState.stale) json['stale'] = true;
    if (state == DashboardTestState.loaded) json['stale'] = false;
    if (state == DashboardTestState.empty) {
      if (data.containsKey('points')) data['points'] = [];
      if (data.containsKey('items')) data['items'] = [];
      if (data.containsKey('positions')) data['positions'] = [];
      if (data.containsKey('buckets')) data['buckets'] = [];
      for (final metric in [
        'volume',
        'fees',
        'revenue',
        'activeUsers',
        'liquidations',
        'openInterest',
        'tvl',
        'netFlows'
      ]) {
        if (data[metric] is Map) {
          data[metric] = {'value': null, 'previous': null, 'changePct': null};
        }
      }
      if (data['margin'] is Map) {
        for (final field in (data['margin'] as Map).keys.toList()) {
          data['margin'][field] = null;
        }
      }
      for (final field in ['deposits', 'withdrawals', 'net']) {
        if (data.containsKey(field)) data[field] = null;
      }
    }
    return json;
  }
}
