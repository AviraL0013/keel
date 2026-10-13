import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../core/config/environment.dart';
import 'status_models.dart';

abstract interface class StatusRepository {
  Future<StatusReport> load();
  Future<IncidentPage> loadIncidentPage({String? cursor});
}

/// Public transport deliberately has no access to wallet or session storage.
class HttpStatusRepository implements StatusRepository {
  const HttpStatusRepository(this.baseUrl, this.client);
  final String baseUrl;
  final http.Client client;

  @override
  Future<StatusReport> load() async {
    return StatusReport.fromJson(await _get(Uri.parse('$baseUrl/status.json')));
  }

  @override
  Future<IncidentPage> loadIncidentPage({String? cursor}) async {
    if (cursor != null && !validIncidentCursor(cursor)) {
      throw const FormatException('Invalid incident cursor');
    }
    final uri = Uri.parse('$baseUrl/status/incidents.json')
        .replace(queryParameters: cursor == null ? null : {'cursor': cursor});
    return IncidentPage.fromJson(await _get(uri));
  }

  Future<Object?> _get(Uri uri) async {
    final response = await client.get(
      uri,
      headers: const {'accept': 'application/json'},
    ).timeout(const Duration(seconds: 12));
    if (response.statusCode != 200) {
      throw StateError('STATUS_HTTP_${response.statusCode}');
    }
    return jsonDecode(response.body);
  }
}

final statusRepositoryProvider = Provider<StatusRepository>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return HttpStatusRepository(ref.watch(configProvider).apiBaseUrl, client);
});
