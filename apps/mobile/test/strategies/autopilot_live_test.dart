import 'package:eyeler_mobile/features/strategies/autopilot_screen.dart';
import 'package:eyeler_mobile/features/strategies/strategy_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'autopilot_layout_test.dart' show FakeStrategies;

class LiveStrategies extends FakeStrategies {
  bool enabled = true;
  bool ready = true;
  bool cleanup = false;
  bool expired = false;
  bool failConfirmation = false;
  String runStatus = 'PAUSED';
  int previews = 0;
  int confirmations = 0;
  int? reviewedDuration;
  final keys = <String>[];
  final controls = <String>[];
  bool isKilled = false;
  int resetCalls = 0;
  @override
  Future<bool> killed() async => isKilled;
  @override
  Future<void> kill() async {
    isKilled = true;
  }

  @override
  Future<void> resetKill() async {
    isKilled = false;
    resetCalls++;
  }

  int published = 0;
  DateTime? publishedFrom;
  DateTime? publishedTo;
  final revoked = <String>[];
  @override
  Future<StrategyPublication> publishEvidence(
      String strategyId, DateTime from, DateTime to) async {
    published++;
    publishedFrom = from;
    publishedTo = to;
    return const StrategyPublication(
        id: 'report-id', url: 'https://api.example/evidence/report-id');
  }

  @override
  Future<void> revokePublication(String publicationId) async {
    revoked.add(publicationId);
  }

  @override
  Future<StrategySetup> setup() async => StrategySetup(
        const [StrategyAccount('connection', 642, 'mainnet')],
        const [StrategyMarket(16, 'BTC')],
        liveEnabled: enabled,
        liveReason: enabled ? null : 'STRATEGIES_LIVE_DISABLED',
      );
  @override
  Future<Map<String, dynamic>> status(String id) async => {
        ...await super.status(id),
        'mode': 'LIVE',
        'status': runStatus,
        'environment': 'mainnet',
        'liveEnabled': enabled,
        'liveReason': enabled ? null : 'STRATEGIES_LIVE_DISABLED',
        'cleanupPending': cleanup,
        'liveState': {
          'baselineEquity': '9007199254740993.000001',
          'peakEquity': '9007199254740993.000003',
        },
        'liveObservation': {
          'accountEquity': '9007199254740993.000003',
          'accountEquityChange': '0.000002',
          'inventory': '0.00001',
          'source': 'Exchange account views',
          'observedAt': '2026-10-13T12:00:00Z',
        },
      };
  @override
  Future<Map<String, dynamic>> livePreview(String id, int maxRunMs) async {
    previews++;
    reviewedDuration = maxRunMs;
    return {
      'previewId': ready ? 'preview-one' : null,
      'ready': ready,
      'reasons': ready ? [] : ['ACCOUNT_NOT_EMPTY'],
      'environment': 'mainnet',
      'accountId': '642',
      'marketId': 16,
      'capital': '1000.000000',
      'maxRunMs': maxRunMs,
      'config': (await super.status(id))['limits'],
      'expiresAt': DateTime.now()
          .toUtc()
          .add(Duration(seconds: expired ? -1 : 15))
          .toIso8601String(),
    };
  }

  @override
  Future<StrategyEntry> confirmLive(
      String id, String previewId, String idempotencyKey) async {
    confirmations++;
    keys.add(idempotencyKey);
    if (failConfirmation) {
      failConfirmation = false;
      throw StateError('CONNECTION_INTERRUPTED');
    }
    runStatus = 'RUNNING';
    return item;
  }

  @override
  Future<StrategyEntry> control(String id, String action) async {
    controls.add(action);
    return item;
  }
}

Future<void> mount(WidgetTester tester, StrategyRepository repo, Widget screen,
    double width) async {
  tester.view.physicalSize = Size(width, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(ProviderScope(
    overrides: [strategyRepositoryProvider.overrideWithValue(repo)],
    child: MaterialApp(theme: ThemeData.dark(), home: screen),
  ));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
      'kill switch reset is explicit and never resumes strategies automatically',
      (tester) async {
    final repo = LiveStrategies();
    await mount(tester, repo, const AutopilotScreen(), 360);
    await tester.tap(find.text('Stop all strategies'));
    await tester.pumpAndSettle();
    expect(find.text('Kill switch ON'), findsOneWidget);
    await tester.tap(find.text('Reset kill switch'));
    await tester.pumpAndSettle();
    expect(repo.resetCalls, 1);
    expect(find.text('Kill switch OFF'), findsOneWidget);
    expect(repo.controls, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });
  for (final width in [360.0, 1280.0]) {
    testWidgets('live draft capability and cleanup fit $width dp',
        (tester) async {
      final repo = LiveStrategies()..enabled = false;
      await mount(tester, repo, const StrategySetupScreen(), width);
      final mode = tester.widget<DropdownButton<String>>(find.descendant(
          of: find.byKey(const Key('strategyMode')),
          matching: find.byType(DropdownButton<String>)));
      expect(mode.items!.singleWhere((item) => item.value == 'LIVE').enabled,
          isFalse);
      expect(find.text('Live unavailable: STRATEGIES_LIVE_DISABLED'),
          findsOneWidget);
      expect(tester.takeException(), isNull);
      repo.enabled = true;
      repo.cleanup = true;
      await mount(tester, repo, const StrategyDashboardScreen(id: 's1'), width);
      expect(find.byKey(const Key('strategyCleanupPending')), findsOneWidget);
      expect(
          find.textContaining('Open positions remain exposed'), findsOneWidget);
      await tester.scrollUntilVisible(find.text('Review live start'), 150);
      final start = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Review live start'));
      expect(start.onPressed, isNull);
      expect(find.text('Account equity change: 0.000002'), findsOneWidget);
      expect(find.text('Last observed account equity: 9007199254740993.000003'),
          findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
        'review requires explicit approval and retries same consent at $width dp',
        (tester) async {
      final repo = LiveStrategies()..failConfirmation = true;
      await mount(tester, repo, const StrategyDashboardScreen(id: 's1'), width);
      await tester.scrollUntilVisible(find.text('Review live start'), 200);
      await tester.tap(find.text('Review live start'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Real money is at risk'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('strategyRunMinutes')), '3');
      await tester.ensureVisible(find.text('Review account and limits'));
      await tester.tap(find.text('Review account and limits'));
      await tester.pumpAndSettle();
      expect(repo.reviewedDuration, 180000);
      expect(repo.confirmations, 0);
      await tester.ensureVisible(find.byKey(const Key('strategyConfirmLive')));
      expect(
          tester
              .widget<FilledButton>(
                  find.byKey(const Key('strategyConfirmLive')))
              .onPressed,
          isNull);
      await tester
          .ensureVisible(find.byKey(const Key('strategyLiveAcknowledgment')));
      await tester.tap(find.byKey(const Key('strategyLiveAcknowledgment')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('strategyConfirmLive')));
      await tester.tap(find.byKey(const Key('strategyConfirmLive')));
      await tester.pumpAndSettle();
      expect(repo.confirmations, 1);
      await tester.ensureVisible(find.byKey(const Key('strategyConfirmLive')));
      await tester.tap(find.byKey(const Key('strategyConfirmLive')));
      await tester.pumpAndSettle();
      expect(repo.confirmations, 2);
      expect(repo.keys.toSet(), hasLength(1));
      expect(repo.controls, isEmpty); // LIVE never calls generic PAPER start.
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('blocked readiness and expired review cannot start real orders',
      (tester) async {
    final repo = LiveStrategies()..ready = false;
    await mount(
        tester,
        repo,
        StrategyLiveReviewSheet(
            id: 's1', status: await repo.status('s1'), repository: repo),
        360);
    await tester.ensureVisible(find.text('Review account and limits'));
    await tester.tap(find.text('Review account and limits'));
    await tester.pumpAndSettle();
    expect(find.text('ACCOUNT_NOT_EMPTY'), findsOneWidget);
    expect(find.byKey(const Key('strategyConfirmLive')), findsNothing);
    repo.ready = true;
    repo.expired = true;
    await tester.ensureVisible(find.text('Refresh review'));
    await tester.tap(find.text('Refresh review'));
    await tester.pumpAndSettle();
    await tester
        .ensureVisible(find.byKey(const Key('strategyLiveAcknowledgment')));
    await tester.tap(find.byKey(const Key('strategyLiveAcknowledgment')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('strategyConfirmLive')));
    expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('strategyConfirmLive')))
            .onPressed,
        isNull);
    expect(repo.confirmations, 0);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
      'owner reviews public report details before publishing, then can revoke the link',
      (tester) async {
    final repo = LiveStrategies();
    await mount(
        tester,
        repo,
        Scaffold(
            body: SingleChildScrollView(
                child: StrategyEvidencePanel(id: 's1', repository: repo))),
        360);
    expect(repo.published, 0);
    await tester
        .ensureVisible(find.byKey(const Key('strategyPublishEvidence')));
    expect(
        tester
            .widget<FilledButton>(
                find.byKey(const Key('strategyPublishEvidence')))
            .onPressed,
        isNull);
    await tester
        .ensureVisible(find.byKey(const Key('strategyEvidenceAcknowledgment')));
    await tester.tap(find.byKey(const Key('strategyEvidenceAcknowledgment')));
    await tester.pumpAndSettle();
    await tester
        .ensureVisible(find.byKey(const Key('strategyPublishEvidence')));
    await tester.tap(find.byKey(const Key('strategyPublishEvidence')));
    await tester.pumpAndSettle();
    expect(repo.published, 1);
    expect(repo.publishedFrom!.isUtc, isTrue);
    expect(repo.publishedTo!.difference(repo.publishedFrom!),
        const Duration(hours: 24));
    expect(find.text('https://api.example/evidence/report-id'), findsOneWidget);
    await tester.ensureVisible(find.text('Revoke link'));
    await tester.tap(find.text('Revoke link'));
    await tester.pumpAndSettle();
    expect(repo.revoked, ['report-id']);
    expect(find.text('https://api.example/evidence/report-id'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
