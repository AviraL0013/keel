import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import '../config/environment.dart';
import '../errors/keel_exception.dart';
import '../storage/session_storage.dart';

class KeelApiClient {
  KeelApiClient(this._config, this._storage, this._http);
  final KeelConfig _config;
  final SessionStorage _storage;
  final http.Client _http;
  Future<T> get<T>(String path, T Function(dynamic) decode) =>
      _request('GET', path, decode);
  Future<T> post<T>(String path,
          {Object? body, required T Function(dynamic) decode}) =>
      _request('POST', path, decode, body: body);
  Future<T> patch<T>(String path,
          {Object? body, required T Function(dynamic) decode}) =>
      _request('PATCH', path, decode, body: body);
  Future<Map<String, dynamic>> health() => _request(
      'GET', '/health', (value) => Map<String, dynamic>.from(value as Map));
  Future<T> _request<T>(String method, String path, T Function(dynamic) decode,
      {Object? body}) async {
    final token = await _storage.readToken();
    final headers = <String, String>{
      if (body != null) 'content-type': 'application/json',
      if (token != null) 'authorization': 'Bearer $token'
    };
    final uri = Uri.parse('${_config.apiBaseUrl}$path');
    final response = switch (method) {
      'GET' => await _http.get(uri, headers: headers),
      'POST' => await _http.post(uri,
          headers: headers, body: body == null ? null : jsonEncode(body)),
      'PATCH' => await _http.patch(uri,
          headers: headers, body: body == null ? null : jsonEncode(body)),
      _ => throw const KeelException('UNSUPPORTED_HTTP_METHOD'),
    };
    if (response.statusCode == 401) await _storage.clear();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final parsed = response.body.isEmpty ? null : jsonDecode(response.body);
      final message = parsed is Map && parsed['error'] is String
          ? parsed['error'] as String
          : 'HTTP_${response.statusCode}';
      final details = parsed is Map ? parsed['details'] : null;
      final policy = message == 'POLICY_REJECTED' && details is Map
          ? PolicyRejection.fromJson(Map<String, dynamic>.from(details))
          : null;
      throw KeelException(message,
          statusCode: response.statusCode, policyRejection: policy);
    }
    return decode(response.body.isEmpty ? null : jsonDecode(response.body));
  }
}

final sessionStorageProvider =
    Provider<SessionStorage>((_) => const SessionStorage());
final apiClientProvider = Provider<KeelApiClient>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return KeelApiClient(
      ref.watch(configProvider), ref.watch(sessionStorageProvider), client);
});
