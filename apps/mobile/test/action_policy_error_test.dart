import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/errors/eyeler_exception.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';

class TestStorage extends SessionStorage {
  @override
  Future<String?> readToken() async => 'test-session';
}

void main() {
  testWidgets(
      'HTTP policy refusal renders backend reason, not offline or raw code',
      (tester) async {
    const reason = 'Automation is paused; no automated action is authorized.';
    final httpClient = MockClient((request) async => http.Response(
        jsonEncode({
          'error': 'POLICY_REJECTED',
          'details': {
            'state': 'HOLD',
            'requestedAction': 'DEFEND',
            'reasons': [reason]
          },
        }),
        409));
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'http://localhost:8787'),
        TestStorage(),
        httpClient);
    late EyelerException rejection;
    try {
      await api.post('/books/test/actions',
          body: {'kind': 'DEFEND'}, decode: (value) => value);
      fail('Expected policy rejection');
    } on EyelerException catch (error) {
      rejection = error;
    }
    expect(rejection.policyRejection?.state, 'HOLD');
    await tester.pumpWidget(MaterialApp(home: Text(friendlyError(rejection))));
    expect(find.text('Action not submitted. $reason'), findsOneWidget);
    expect(find.textContaining('server unavailable'), findsNothing);
    expect(find.text('POLICY_REJECTED'), findsNothing);
    httpClient.close();
  });

  test('older refusal responses still have a readable fallback', () {
    const error = EyelerException('POLICY_REJECTED', statusCode: 409);
    expect(error.userMessage, contains('backend risk policy'));
    expect(error.userMessage, isNot(contains('server unavailable')));
  });

  test('venue rate limit is not reported as EYELER server outage', () {
    const error = EyelerException('PERPL_RATE_LIMITED', statusCode: 503);
    expect(error.userMessage, contains('Perpl is rate limiting EYELER'));
    expect(error.userMessage, isNot(contains('server unavailable')));
  });

  test('insufficient Perpl free balance explains that DEFEND was not sent', () {
    const error =
        EyelerException('PERPL_FREE_BALANCE_INSUFFICIENT', statusCode: 409);
    expect(error.userMessage, contains('not submitted'));
    expect(error.userMessage, contains('free balance'));
  });

  test('stale Perpl balance explains that DEFEND was not sent', () {
    const error =
        EyelerException('PERPL_FREE_BALANCE_UNAVAILABLE', statusCode: 409);
    expect(error.userMessage, contains('not submitted'));
    expect(error.userMessage, contains('balance'));
  });
}
