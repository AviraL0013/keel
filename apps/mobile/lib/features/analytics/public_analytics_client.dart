import 'dart:convert';

import 'package:http/http.dart' as http;

/// Public data transport deliberately has no access to session or wallet storage.
class PublicAnalyticsClient {
  const PublicAnalyticsClient(this.baseUrl, this.client);
  final String baseUrl;
  final http.Client client;

  Future<Object?> get(String path) async {
    final relative = Uri.parse(path);
    if (relative.hasScheme ||
        relative.hasAuthority ||
        relative.hasFragment ||
        !relative.path.startsWith('/analytics/v1/') ||
        relative.pathSegments.any(
            (part) => part == '.' || part == '..' || part.contains('\\'))) {
      throw const FormatException('Invalid public analytics path');
    }
    final response = await client.get(Uri.parse('$baseUrl$path'),
        headers: const {'accept': 'application/json'});
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('ANALYTICS_HTTP_${response.statusCode}');
    }
    return jsonDecode(response.body);
  }
}
