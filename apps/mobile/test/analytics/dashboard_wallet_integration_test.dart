import 'dart:async';
import 'dart:io';

import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/analytics/analytics_local_store.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_data.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_style.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet_tools.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'dashboard_fixture.dart';

class _WalletData extends RecordedDashboard {
  int profileCalls = 0;
  Completer<Object?>? pendingProfile;

  @override
  Future<Object?> get(String path) async {
    if (path.endsWith('/activity')) {
      return {
        'asOf': RecordedDashboard.now.toIso8601String(),
        'block': 112463852,
        'source': 'monad_exchange',
        'stale': false,
        'data': {
          'address': RecordedDashboard.wallet,
          'scope': 'currently_linked_accounts',
          'activeDays': 1,
          'verifiedDays': 30,
          'points': [],
          'unavailableReason': null,
        },
      };
    }
    final raw = await super.get(path);
    final isProfile = Uri.parse(path).path.toLowerCase() ==
        '/analytics/v1/wallets/${RecordedDashboard.wallet.toLowerCase()}';
    if (!isProfile) return raw;
    profileCalls++;
    final response = raw as Map<String, dynamic>;
    response['block'] = (response['block'] as int) + profileCalls - 1;
    response['asOf'] = DateTime.parse(response['asOf'] as String)
        .add(Duration(seconds: 30 * (profileCalls - 1)))
        .toIso8601String();
    if (profileCalls > 1) {
      final position = (response['data']['positions'] as List).first as Map;
      for (final field in ['size', 'notional']) {
        final value = AnalyticsDecimal.parse(position[field] as String);
        position[field] =
            AnalyticsDecimal(value.units * BigInt.two, value.scale).toString();
      }
      if (pendingProfile != null) return pendingProfile!.future;
    }
    return response;
  }
}

Future<void> _mountWallet(WidgetTester tester, double width, _WalletData data,
    DateTime Function() now) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, 1000);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(ProviderScope(
    overrides: [
      dashboardApiProvider.overrideWithValue(DashboardApi(data.get, now: now)),
      dashboardNowProvider.overrideWithValue(now),
      analyticsLocalStoreProvider
          .overrideWithValue(MemoryAnalyticsLocalStore()),
    ],
    child: MaterialApp(
        theme: EyelerTheme.dark,
        home: DashboardWalletProfile(address: RecordedDashboard.wallet)),
  ));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    for (final (family, path) in [
      ('Manrope_regular', 'assets/fonts/Manrope-Regular.ttf'),
      ('Manrope_600', 'assets/fonts/Manrope-SemiBold.ttf'),
      ('Manrope_700', 'assets/fonts/Manrope-Bold.ttf'),
      ('MaterialIcons', 'test/fixtures/analytics/MaterialIcons-Regular.otf'),
    ]) {
      final bytes = await File(path).readAsBytes();
      await (FontLoader(family)
            ..addFont(Future.value(ByteData.sublistView(bytes))))
          .load();
    }
  });

  for (final width in [360.0, 1280.0]) {
    testWidgets('public wallet page mounts both tools and watches at $width',
        (tester) async {
      final data = _WalletData();
      var now = RecordedDashboard.now;
      await _mountWallet(tester, width, data, () => now);
      await tester.scrollUntilVisible(find.byType(DashboardWalletTools), 500,
          scrollable: find.byType(Scrollable).first);
      await tester.pumpAndSettle();
      expect(find.text('Position insights'), findsOneWidget);
      expect(find.text('Stress my wallet'), findsOneWidget);
      await tester.ensureVisible(find.text('-5%'));
      await tester.tap(find.text('-5%'));
      await tester.pump();
      expect(find.text('Price move: -5%'), findsOneWidget);
      await tester.ensureVisible(find.text('Start live watch'));
      await tester.tap(find.text('Start live watch'));
      await tester.pump();
      now = now.add(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 31));
      await tester.pumpAndSettle();
      expect(data.profileCalls, 2);
      expect(find.text('Observed size increased'), findsOneWidget);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      now = now.add(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 31));
      expect(data.profileCalls, 2);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.ensureVisible(find.text('Resume watch'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Resume watch'));
      await tester.pumpAndSettle();
      final beforeLeavingTab = data.profileCalls;
      await tester.ensureVisible(find.byKey(const Key('wallet_tab_1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('wallet_tab_1')));
      await tester.pumpAndSettle();
      expect(find.byType(DashboardWalletTools), findsNothing);
      now = now.add(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 31));
      expect(data.profileCalls, beforeLeavingTab);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('live refresh retains wallet KPIs while tools scroll off screen',
      (tester) async {
    final data = _WalletData();
    var now = RecordedDashboard.now;
    await _mountWallet(tester, 360, data, () => now);
    final originalEquity =
        tester.widget<Text>(find.byKey(const ValueKey('value_Equity'))).data;
    await tester.scrollUntilVisible(find.byType(DashboardWalletTools), 500,
        scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Start live watch'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Start live watch'));
    await tester.pump();
    // Scroll to the top. A running watch must stay alive within this tab.
    final scrollable =
        tester.state<ScrollableState>(find.byType(Scrollable).first);
    scrollable.position.jumpTo(0);
    await tester.pumpAndSettle();
    data.pendingProfile = Completer<Object?>();
    now = now.add(const Duration(seconds: 31));
    await tester.pump(const Duration(seconds: 31));
    await tester.pump();
    expect(data.profileCalls, 2);
    expect(tester.widget<Text>(find.byKey(const ValueKey('value_Equity'))).data,
        originalEquity);
    final equity = find
        .ancestor(
            of: find.byKey(const ValueKey('value_Equity')),
            matching: find.byType(DashboardKpi))
        .first;
    expect(
        find.descendant(of: equity, matching: find.byType(DashboardSkeleton)),
        findsNothing);
    data.pendingProfile!.completeError(StateError('Test refresh ended'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
