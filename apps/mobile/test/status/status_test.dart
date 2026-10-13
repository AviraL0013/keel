import 'dart:convert';

import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/features/status/status_models.dart';
import 'package:eyeler_mobile/features/status/status_repository.dart';
import 'package:eyeler_mobile/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, Object?> reportFixture() => {
      'version': 1,
      'run': {
        'id': 'fixture-run',
        'startedAt': '2026-10-13T20:00:00.000Z',
        'endsAt': '2026-10-20T20:00:00.000Z',
        'status': 'running',
        'environment': 'mainnet',
        'durationDays': 7,
      },
      'observedAt': '2026-10-13T21:00:00.000Z',
      'availability': {
        'uptimePercent': 99.5,
        'observedSeconds': 3582,
        'unobservedSeconds': 18,
        'lastHeartbeatAt': '2026-10-13T21:00:00.000Z',
        'workerTickAgeMs': 800,
        'lockOwned': true,
        'handovers': 1,
        'websocket': {'disconnects': 2, 'reconnects': 2, 'available': true},
      },
      'books': {
        'armedCount': 1,
        'duplicateActions': 0,
        'decisions': [
          {
            'at': '2026-10-13T20:50:00Z',
            'kind': 'HOLD',
            'status': 'observed',
            'reasonCodes': ['WITHIN_LIMITS'],
          },
        ],
        'actions': [
          {
            'at': '2026-10-13T20:45:00Z',
            'kind': 'DEFEND',
            'status': 'CONFIRMED',
            'explorerUrl':
                'https://monadscan.com/tx/0x${List.filled(64, 'a').join()}',
          },
        ],
      },
      'paper': {
        'runningCount': 1,
        'simulatedOrders': 4,
        'simulatedFills': 2,
        'stats': [],
      },
      'analytics': {
        'indexedBlock': 123,
        'confirmedHead': 125,
        'lagBlocks': 2,
        'verifiedDays': 30,
        'requestedDays': 30,
        'historyVerified': true,
      },
      'incidents': [
        {
          'id': 'fixture-incident',
          'kind': 'scheduled_restart',
          'scope': 'mainnet',
          'detectedAt': '2026-10-13T20:30:00Z',
          'recoveredAt': '2026-10-13T20:30:04Z',
          'status': 'recovered',
          'durationMs': 4000,
          'summary': 'Injected restart recovered with one lock owner.',
        },
      ],
      'chaos': [
        {
          'scenario': 'rpc_timeout',
          'at': '2026-10-13T20:25:00Z',
          'status': 'passed',
          'recoveryMs': 3000,
          'invariants': {
            'noDuplicateOrders': true,
            'noUnknownResubmission': true,
            'noPartialResubmission': true,
            'failClosed': true,
          },
        },
      ],
      'limitations': ['Paper execution is simulated.'],
    };

class PrivateStorage extends SessionStorage {
  int reads = 0;
  @override
  Future<String?> readToken() async {
    reads++;
    throw StateError('Public status must not read private storage');
  }
}

class FixtureStatusRepository implements StatusRepository {
  const FixtureStatusRepository(this.report);
  final StatusReport report;
  @override
  Future<StatusReport> load() async => report;
  @override
  Future<IncidentPage> loadIncidentPage({String? cursor}) async => IncidentPage(
      incidents: report.incidents,
      nextCursor: null,
      total: report.incidents.length);
}

class ToggleStatusRepository implements StatusRepository {
  int calls = 0;
  bool fail = false;
  @override
  Future<StatusReport> load() async {
    calls++;
    if (fail) throw StateError('must-not-render-secret');
    return StatusReport.fromJson(reportFixture());
  }

  @override
  Future<IncidentPage> loadIncidentPage({String? cursor}) async =>
      const IncidentPage(incidents: [], nextCursor: null, total: 0);
}

class PagedStatusRepository implements StatusRepository {
  final requests = <String?>[];
  @override
  Future<StatusReport> load() async => StatusReport.fromJson({
        ...reportFixture(),
        'incidents': [],
        'totalIncidents': 205,
        'incidentPreviewTruncated': true,
      });
  @override
  Future<IncidentPage> loadIncidentPage({String? cursor}) async {
    requests.add(cursor);
    final offset = cursor == null
        ? 0
        : cursor == 'cGFnZTI'
            ? 100
            : 200;
    return IncidentPage.fromJson({
      'incidents': [
        for (var index = offset; index < (offset + 100).clamp(0, 205); index++)
          {
            'id':
                '00000000-0000-4000-8000-${index.toString().padLeft(12, '0')}',
            'kind': 'scheduled_restart',
            'scope': 'mainnet',
            'status': 'recovered',
            'summary': 'History incident $index',
            'detectedAt': '2026-10-13T20:00:00Z',
            'recoveredAt': '2026-10-13T20:00:04Z',
            'durationMs': 4000
          }
      ],
      'nextCursor': offset == 0
          ? 'cGFnZTI'
          : offset == 100
              ? 'cGFnZTM'
              : null,
      'total': 205,
    });
  }
}

void main() {
  test('incident and chaos preview caps match the published contract', () {
    final json = reportFixture();
    final incident = (json['incidents'] as List).single;
    final chaos = (json['chaos'] as List).single;
    json['incidents'] = List.filled(1001, incident);
    json['chaos'] = List.filled(2001, chaos);
    json['totalIncidents'] = 1001;
    json['incidentPreviewTruncated'] = true;
    final report = StatusReport.fromJson(json);
    expect(report.incidents.length, 1000);
    expect(report.chaos.length, 2000);
    expect(report.totalIncidents, 1001);
    expect(report.incidentPreviewTruncated, isTrue);
  });

  test(
      'incident page transport remains anonymous and accepts only opaque cursors',
      () async {
    final client = MockClient((request) async {
      expect(request.url.path, '/status/incidents.json');
      expect(request.url.queryParameters, {'cursor': 'cGFnZTI'});
      expect(request.headers.containsKey('authorization'), isFalse);
      expect(request.headers.containsKey('cookie'), isFalse);
      return http.Response(
          jsonEncode({'incidents': [], 'nextCursor': null, 'total': 0}), 200);
    });
    addTearDown(client.close);
    final repository = HttpStatusRepository('https://fixture.invalid', client);
    expect((await repository.loadIncidentPage(cursor: 'cGFnZTI')).total, 0);
    await expectLater(
        repository.loadIncidentPage(cursor: '../private?token=secret'),
        throwsFormatException);
  });

  testWidgets(
      'full incident history reaches rows after 200 with anonymous pagination',
      (tester) async {
    final repository = PagedStatusRepository();
    final storage = PrivateStorage();
    await tester.pumpWidget(ProviderScope(overrides: [
      statusRepositoryProvider.overrideWithValue(repository),
      sessionStorageProvider.overrideWithValue(storage),
    ], child: const EyelerApp(initialRoute: '/status')));
    await tester.pumpAndSettle();
    expect(repository.requests, [null]);
    for (var page = 0; page < 2; page++) {
      await tester.scrollUntilVisible(find.text('Load more incidents'), 1500,
          scrollable: find.byType(Scrollable).first, maxScrolls: 80);
      await tester.tap(find.text('Load more incidents'));
      await tester.pumpAndSettle();
    }
    expect(repository.requests, [null, 'cGFnZTI', 'cGFnZTM']);
    await tester.ensureVisible(find.text('History incident 204'));
    expect(find.text('History incident 204'), findsOneWidget);
    expect(find.text('Loaded 205 of 205 incidents.'), findsOneWidget);
    expect(find.text('Load more incidents'), findsNothing);
    expect(storage.reads, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
      'unavailable failure evidence never becomes a failed or successful measurement',
      (tester) async {
    final json = reportFixture();
    json['chaos'] = [
      {
        'scenario': 'rpc-timeout',
        'status': 'unavailable',
        'recoveryMs': null,
        'invariants': {
          'noDuplicateOrders': null,
          'noUnknownResubmission': null,
          'noPartialResubmission': null,
          'failClosed': null
        }
      }
    ];
    await tester.pumpWidget(ProviderScope(overrides: [
      statusRepositoryProvider.overrideWithValue(
          FixtureStatusRepository(StatusReport.fromJson(json))),
    ], child: const EyelerApp(initialRoute: '/status')));
    await tester.pumpAndSettle();
    expect(find.text('No duplicate orders: Unavailable'), findsOneWidget);
    expect(find.text('Recovery: Unavailable'), findsOneWidget);
    expect(find.text('No duplicate orders: Passed'), findsNothing);
    expect(find.text('No duplicate orders: Failed'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
  test('anonymous transport uses only status endpoint', () async {
    final client = MockClient((request) async {
      expect(request.url.toString(), 'https://fixture.invalid/status.json');
      expect(request.method, 'GET');
      expect(request.headers.containsKey('authorization'), isFalse);
      expect(request.headers.containsKey('cookie'), isFalse);
      return http.Response(jsonEncode(reportFixture()), 200);
    });
    addTearDown(client.close);
    final report = await HttpStatusRepository(
      'https://fixture.invalid',
      client,
    ).load();
    expect(report.run.status, 'running');
    expect(report.availability.uptimePercent, 99.5);
  });

  test('unknown values stay null and unsupported versions fail visibly', () {
    final report = StatusReport.fromJson({'version': 1});
    expect(report.availability.lockOwned, isNull);
    expect(report.availability.uptimePercent, isNull);
    expect(report.books.armedCount, isNull);
    expect(report.run.startedAt, isNull);
    expect(() => StatusReport.fromJson({'version': 2}), throwsFormatException);
  });

  test('campaign not started differs from a measured zero', () {
    final report = StatusReport.fromJson({
      'version': 1,
      'run': null,
      'books': {'armedCount': 0},
      'paper': {
        'runningCount': 0,
        'stats': [
          {'label': 'Status', 'value': 'No running paper strategies'}
        ]
      },
      'alerts': {'configured': false, 'linkedRecipients': 0},
    });
    expect(report.run.status, 'not_started');
    expect(report.books.armedCount, 0);
    expect(report.paper.stats.single.value, 'No running paper strategies');
    expect(report.availability.uptimePercent, isNull);
    expect(report.alertsConfigured, isFalse);
    expect(report.linkedAlertRecipients, 0);
  });

  test('safe report parser hides unexpected fields and non-explorer links', () {
    final json = reportFixture();
    json['wallet'] = '0x1111111111111111111111111111111111111111';
    json['secret'] = 'do-not-show';
    (json['books'] as Map)['actions'] = [
      {
        'kind': 'DEFEND',
        'status': 'UNKNOWN',
        'explorerUrl':
            'https://evil.invalid/tx/0x${List.filled(64, 'a').join()}',
      },
    ];
    final report = StatusReport.fromJson(json);
    expect(report.books.actions.single.explorerUrl, isNull);
    expect(
      safeStatusText('wallet 0x1111111111111111111111111111111111111111'),
      'wallet [redacted]',
    );
    expect(
      safeStatusText('AWS arn:aws:kms:ap-southeast-1:123456789012:key/example'),
      'AWS [redacted]',
    );
  });

  test(
      'production report explorer links survive parsing and unsafe URLs do not',
      () {
    final hash = '0x${List.filled(64, 'b').join()}';
    final json = reportFixture();
    (json['books'] as Map)['actions'] = [
      {
        'kind': 'DEFEND',
        'status': 'CONFIRMED',
        'explorerUrl': 'https://monadvision.com/tx/$hash'
      },
      {
        'kind': 'REDUCE',
        'status': 'CONFIRMED',
        'explorerUrl': 'https://monadvision.com/block/123456789'
      },
    ];
    final actions = StatusReport.fromJson(json).books.actions;
    expect(
        actions[0].explorerUrl.toString(), 'https://monadvision.com/tx/$hash');
    expect(actions[1].explorerUrl.toString(),
        'https://monadvision.com/block/123456789');
    expect(publicExplorerUrl('https://monadscan.com/tx/$hash'), isNotNull);
    for (final value in [
      'http://monadvision.com/tx/$hash',
      'https://monadvision.com.evil.invalid/tx/$hash',
      'https://secret@monadvision.com/tx/$hash',
      'https://monadvision.com:8443/tx/$hash',
      'https://monadvision.com/tx/$hash?token=secret',
      'https://monadvision.com/tx/$hash#wallet',
      'https://monadvision.com/block/0',
      'https://monadvision.com/block/-1',
      'https://monadvision.com/block/1.5',
      'https://monadvision.com/address/0x${List.filled(40, 'b').join()}',
    ]) {
      expect(publicExplorerUrl(value), isNull);
    }
  });

  test(
      'fractional chaos recovery remains measured and invalid values stay unknown',
      () {
    final json = reportFixture();
    json['chaos'] = [
      {'scenario': 'rpc-timeout', 'status': 'passed', 'recoveryMs': 0.4},
      {'scenario': 'rpc-timeout', 'status': 'unavailable', 'recoveryMs': -1},
      {'scenario': 'rpc-timeout', 'status': 'unavailable', 'recoveryMs': 'NaN'},
    ];
    final report = StatusReport.fromJson(json);
    expect(report.chaos[0].recoveryMs, 0.4);
    expect(report.chaos[1].recoveryMs, isNull);
    expect(report.chaos[2].recoveryMs, isNull);
    expect(report.incidents.single.durationMs, 4000);
  });

  test('failed public request exposes no raw response body', () async {
    final client = MockClient((_) async => http.Response('secret-body', 503));
    addTearDown(client.close);
    await expectLater(
      HttpStatusRepository('https://fixture.invalid', client).load(),
      throwsA(
        predicate((error) => error.toString() == 'Bad state: STATUS_HTTP_503'),
      ),
    );
  });

  for (final width in [360.0, 1280.0]) {
    testWidgets(
      'status deep link bypasses auth and renders at ${width.toInt()}px',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = Size(width, 1000);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);
        final storage = PrivateStorage();
        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              sessionStorageProvider.overrideWithValue(storage),
              statusRepositoryProvider.overrideWithValue(
                FixtureStatusRepository(StatusReport.fromJson(reportFixture())),
              ),
            ],
            child: const EyelerApp(initialRoute: '/status'),
          ),
        );
        await tester.pumpAndSettle();
        expect(storage.reads, 0);
        expect(find.text('7-day run report'), findsOneWidget);
        expect(find.text('99.50%'), findsOneWidget);
        expect(find.text('SIGN IN WITH PASSKEY'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.scrollUntilVisible(
          find.text('Failure testing'),
          400,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text('No duplicate orders: Passed'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }

  testWidgets(
      'poll failure preserves evidence with notice, and pause prevents polling',
      (tester) async {
    final repository = ToggleStatusRepository();
    await tester.pumpWidget(ProviderScope(overrides: [
      statusRepositoryProvider.overrideWithValue(repository),
    ], child: const EyelerApp(initialRoute: '/status')));
    await tester.pumpAndSettle();
    expect(repository.calls, 1);
    repository.fail = true;
    await tester.pump(const Duration(seconds: 15));
    await tester.pumpAndSettle();
    expect(repository.calls, 2);
    expect(find.text('99.50%'), findsOneWidget);
    expect(
        find.textContaining('Report could not be refreshed.'), findsOneWidget);
    expect(find.textContaining('must-not-render-secret'), findsNothing);
    await tester.tap(find.text('Pause updates'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 30));
    expect(repository.calls, 2);
    expect(find.text('Resume updates'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('sub-millisecond recovery is not rounded to zero',
      (tester) async {
    final json = reportFixture();
    (json['chaos'] as List).cast<Map>().single['recoveryMs'] = 0.4;
    await tester.pumpWidget(ProviderScope(overrides: [
      statusRepositoryProvider.overrideWithValue(
          FixtureStatusRepository(StatusReport.fromJson(json))),
    ], child: const EyelerApp(initialRoute: '/status')));
    await tester.pumpAndSettle();
    expect(find.text('Recovery: <1ms'), findsOneWidget);
    expect(find.text('Recovery: 0.0s'), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
