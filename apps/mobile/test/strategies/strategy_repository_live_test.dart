import 'dart:convert';

import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/features/strategies/strategy_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class OwnerSession extends SessionStorage {
  @override
  Future<String?> readToken() async => 'owner-session';
}

void main() {
  test(
      'review/confirmation and evidence use authenticated API with explicit consent and API-host URLs',
      () async {
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      if (request.url.path.endsWith('/live-preview')) {
        return http.Response(
            jsonEncode({'ready': true, 'previewId': 'preview'}), 200);
      }
      if (request.url.path.endsWith('/live-confirm')) {
        return http.Response(
            jsonEncode({
              'id': 's1',
              'mode': 'LIVE',
              'kind': 'GRID',
              'status': 'RUNNING',
              'market_id': 16,
              'account_id': '642',
              'capital': '1000.000000',
              'state': {}
            }),
            200);
      }
      if (request.method == 'DELETE') return http.Response('{}', 200);
      final row = {'id': 'report-id', 'path': '/evidence/report-id'};
      return http.Response(
          jsonEncode(request.method == 'GET' ? [row] : row), 200);
    });
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'https://api.example/v1'),
        OwnerSession(),
        client);
    final repo = HttpStrategyRepository(api);
    await repo.livePreview('s1', 180000);
    await repo.confirmLive('s1', 'preview', 'fixed-idempotency-key');
    final from = DateTime.utc(2026, 10, 12), to = DateTime.utc(2026, 10, 13);
    final publication = await repo.publishEvidence('s1', from, to);
    expect(publication.url, 'https://api.example/v1/evidence/report-id');
    expect((await repo.publications('s1')).single.url, publication.url);
    await repo.revokePublication(publication.id);
    expect(jsonDecode(requests[0].body), {'maxRunMs': 180000});
    expect(jsonDecode(requests[1].body), {
      'previewId': 'preview',
      'idempotencyKey': 'fixed-idempotency-key',
      'acknowledgeRealOrders': true
    });
    expect(jsonDecode(requests[2].body), {
      'strategyId': 's1',
      'from': from.toIso8601String(),
      'to': to.toIso8601String(),
      'ownerReviewed': true
    });
    expect(
        requests.every((request) =>
            request.headers['authorization'] == 'Bearer owner-session'),
        isTrue);
    expect(requests.last.method, 'DELETE');
    expect(requests.last.url.toString(),
        'https://api.example/v1/strategies/evidence-publications/report-id');
    expect(() => api.resolve('//external.example/evidence'),
        throwsA(isA<Exception>()));
    client.close();
  });
}
