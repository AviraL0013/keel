import 'dart:io';

import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/analytics/analytics_local_store.dart';
import 'package:eyeler_mobile/features/analytics/analytics_models.dart';
import 'package:eyeler_mobile/features/analytics/analytics_repository.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_chart.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_data.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_market.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_screen.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_style.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet.dart';
import 'package:eyeler_mobile/features/analytics/wallet_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'dashboard_fixture.dart';

Future<void> mountDashboard(
    WidgetTester tester, double width, Widget child, RecordedDashboard recorded,
    {MemoryAnalyticsLocalStore? store, double height = 1000}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(ProviderScope(
      overrides: [
        dashboardApiProvider.overrideWithValue(recorded.api),
        dashboardNowProvider.overrideWithValue(() => RecordedDashboard.now),
        analyticsRepositoryProvider.overrideWithValue(HttpAnalyticsRepository(
            recorded.get,
            now: () => RecordedDashboard.now)),
        analyticsLocalStoreProvider
            .overrideWithValue(store ?? MemoryAnalyticsLocalStore()),
      ],
      child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: EyelerTheme.dark,
          home: child)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 250));
}

Future<void> disposeDashboard(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 20));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
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
    for (final state in DashboardTestState.values) {
      for (var section = 0; section < 5; section++) {
        testWidgets(
            '${dashboardSections[section]} $state at ${width.toInt()}dp',
            (tester) async {
          final recorded = RecordedDashboard(state: state);
          await mountDashboard(tester, width,
              AnalyticsDashboard(initialSection: section), recorded);
          expect(
              find.text('Eyeler Analytics · Perpl on Monad'), findsOneWidget);
          if (state == DashboardTestState.loading) {
            expect(find.byType(DashboardSkeleton), findsWidgets);
          }
          if (state == DashboardTestState.unavailable) {
            expect(find.textContaining('unavailable', findRichText: true),
                findsWidgets);
          }
          if (state == DashboardTestState.empty) {
            expect(find.textContaining('—'), findsWidgets);
            if (section == 0) {
              expect(find.text('Trader count is not verified.'), findsWidgets);
            }
          }
          if (state == DashboardTestState.stale) {
            expect(find.textContaining('Data may be delayed or incomplete'),
                findsWidgets);
            expect(find.textContaining('Stale / partial'), findsNothing);
          }
          // Build lower sections as well, checking overflow and lazy requests.
          if (state != DashboardTestState.loading) {
            for (var i = 0; i < 4; i++) {
              await tester.drag(
                  find.byType(ListView).first, const Offset(0, -650));
              await tester.pump(const Duration(milliseconds: 250));
              expect(tester.takeException(), isNull);
            }
          }
          expect(tester.takeException(), isNull);
          await disposeDashboard(tester);
        });
      }
      testWidgets('Wallet $state at ${width.toInt()}dp', (tester) async {
        await mountDashboard(
            tester,
            width,
            DashboardWalletProfile(address: RecordedDashboard.wallet),
            RecordedDashboard(state: state));
        expect(find.text('Wallet profile'), findsOneWidget);
        expect(find.text('Margin used'), findsOneWidget);
        for (var i = 0; i < 4 && state != DashboardTestState.loading; i++) {
          await tester.drag(find.byType(ListView).first, const Offset(0, -600));
          await tester.pump(const Duration(milliseconds: 200));
          expect(tester.takeException(), isNull);
        }
        expect(tester.takeException(), isNull);
        await disposeDashboard(tester);
      });
      testWidgets('Wallets comparison $state at ${width.toInt()}dp',
          (tester) async {
        final store = MemoryAnalyticsLocalStore()
          ..saved = state == DashboardTestState.empty
              ? []
              : [RecordedDashboard.wallet];
        await mountDashboard(
            tester,
            width,
            const AnalyticsDashboard(initialSection: 5),
            RecordedDashboard(state: state),
            store: store);
        await tester.tap(find.text('Watchlist & compare'));
        await tester.pumpAndSettle();
        expect(find.textContaining('/4 wallets'), findsOneWidget);
        if (state == DashboardTestState.loading) {
          expect(find.byType(DashboardSkeleton), findsWidgets);
        }
        if (state == DashboardTestState.empty) {
          expect(find.textContaining('No saved wallets'), findsOneWidget);
        }
        if (state == DashboardTestState.unavailable) {
          expect(find.text('Retry snapshot'), findsOneWidget);
        }
        expect(tester.takeException(), isNull);
        await disposeDashboard(tester);
      });
    }
  }

  testWidgets(
      'global timeframe updates independent chart requests and preserves 24h KPI',
      (tester) async {
    final recorded = RecordedDashboard();
    await mountDashboard(tester, 1280, const AnalyticsDashboard(), recorded);
    expect(find.text(r'$11.39M'), findsOneWidget);
    await tester.tap(find.byKey(const Key('range_7D')));
    await tester.pumpAndSettle();
    expect(
        recorded.requests.where((p) => p.contains('timeseries')).any((p) =>
            Uri.parse(p).queryParameters['from'] == '2026-10-04T00:00:00.000Z'),
        isTrue);
    expect(find.text(r'$11.39M'), findsOneWidget);
    await tester.tap(find.byKey(const Key('range_90D')));
    await tester.pumpAndSettle();
    expect(
        recorded.requests.any((p) =>
            Uri.parse(p).queryParameters['from'] == '2026-07-13T00:00:00.000Z'),
        isTrue);
    await tester.tap(find.byKey(const Key('range_All')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Up to 2 years'), findsWidgets);
    expect(tester.takeException(), isNull);
    await disposeDashboard(tester);
  });

  testWidgets('Ctrl K and Cmd K focus global search; address opens profile',
      (tester) async {
    await mountDashboard(
        tester, 1280, const AnalyticsDashboard(), RecordedDashboard());
    for (final modifier in [
      LogicalKeyboardKey.controlLeft,
      LogicalKeyboardKey.metaLeft
    ]) {
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.sendKeyDownEvent(modifier);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
      await tester.sendKeyUpEvent(modifier);
      await tester.pump();
      final field =
          tester.widget<TextField>(find.byKey(const Key('global_search')));
      expect(field.focusNode!.hasFocus, isTrue);
    }
    await tester.enterText(
        find.byKey(const Key('global_search')), RecordedDashboard.wallet);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.byType(DashboardWalletProfile), findsOneWidget);
    expect(find.text(r'$999.94K'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await disposeDashboard(tester);
  });

  testWidgets('phone search opens full-screen lookup with 48dp target',
      (tester) async {
    await mountDashboard(
        tester, 360, const AnalyticsDashboard(), RecordedDashboard());
    final button = find.byKey(const Key('mobile_search'));
    expect(tester.getSize(button).width, greaterThanOrEqualTo(48));
    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(find.byType(AnalyticsWalletSearchScreen), findsOneWidget);
    expect(find.text('Search wallets'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'invalid');
    await tester.tap(find.byTooltip('Search wallet'));
    await tester.pump();
    expect(find.textContaining('six hexadecimal'), findsOneWidget);
    await disposeDashboard(tester);
  });

  testWidgets('range brush exports only dates and series still visible',
      (tester) async {
    final recorded = RecordedDashboard();
    final data = await recorded.api.history('volume', DashboardRange.month);
    String? copied;
    tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String;
      }
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));
    await mountDashboard(
        tester,
        1280,
        AnalyticsDark(
            child: Scaffold(
                body: DashboardChartCard(
          title: 'Volume range',
          description: 'Recorded mainnet observations',
          brush: true,
          series: [
            DashboardSeries('Volume',
                data.data.total.points.map((p) => p.toView()).toList())
          ],
        ))),
        recorded);
    final slider = tester.getRect(find.byType(RangeSlider));
    await tester.dragFrom(Offset(slider.left + 24, slider.center.dy),
        Offset(slider.width * .55, 0));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Export Volume range CSV'));
    await tester.pump();
    expect(copied, contains('2026-10-10T00:00:00.000Z'));
    expect(copied, isNot(contains('2026-09-11T00:00:00.000Z')));
    expect(tester.takeException(), isNull);
    await disposeDashboard(tester);
  });

  testWidgets('market drill-down opens independent price and funding history',
      (tester) async {
    await mountDashboard(tester, 1280,
        const AnalyticsDashboard(initialSection: 1), RecordedDashboard());
    await tester.drag(find.byType(ListView).first, const Offset(0, -700));
    await tester.pumpAndSettle();
    await tester.tap(find.text('BTC').first);
    await tester.pumpAndSettle();
    expect(find.byType(DashboardMarketScreen), findsOneWidget);
    expect(find.text('Price'), findsOneWidget);
    expect(find.text('Funding history'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await disposeDashboard(tester);
  });

  testWidgets(
      'wallet survives performance failure; Watch and Compare retain real address',
      (tester) async {
    final store = MemoryAnalyticsLocalStore();
    await mountDashboard(
        tester,
        1280,
        DashboardWalletProfile(address: RecordedDashboard.wallet),
        RecordedDashboard(),
        store: store);
    expect(find.text(r'$999.94K'), findsOneWidget);
    expect(find.text('—'), findsWidgets);
    await tester.tap(find.text('Watch'));
    await tester.pump();
    expect(store.saved, [RecordedDashboard.wallet]);
    await tester.tap(find.text('Compare'));
    await tester.pumpAndSettle();
    expect(find.byType(DashboardCompareScreen), findsOneWidget);
    expect(find.textContaining('1/4 wallets'), findsOneWidget);
    expect(find.text(r'$999.94K'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const Key('wallet_tab_1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('wallet_tab_1')));
    await tester.pumpAndSettle();
    expect(find.text('Trade history unavailable from the source.'),
        findsOneWidget);
    expect(tester.takeException(), isNull);
    await disposeDashboard(tester);
  });

  for (final width in [360.0, 1280.0]) {
    testWidgets(
        'tooltip exact values, legend, chart type, brush and CSV at ${width.toInt()}dp',
        (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String;
        }
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));
      final dates = [DateTime.utc(2026, 10, 5), DateTime.utc(2026, 10, 6)];
      await mountDashboard(
          tester,
          width,
          AnalyticsDark(
              child: Scaffold(
                  body: SingleChildScrollView(
                      child: DashboardChartCard(
            title: 'Volume',
            description: 'Explicit test values',
            cumulative: true,
            stacked: true,
            granularity: true,
            brush: true,
            series: [
              DashboardSeries('BTC', [
                AnalyticsPoint(dates[0], '1.000001'),
                AnalyticsPoint(dates[1], '9007199254740993.123456')
              ]),
              DashboardSeries('ETH', [
                AnalyticsPoint(dates[0], '2.000002'),
                AnalyticsPoint(dates[1], '3.000003')
              ])
            ],
          )))),
          RecordedDashboard());
      final plot = find.byKey(const Key('plot_Volume'));
      final rect = tester.getRect(plot);
      await tester.tapAt(Offset(rect.right - 60, rect.center.dy));
      await tester.pump();
      expect(find.textContaining('9007199254740993.123456'), findsOneWidget);
      expect(
          find.textContaining('2026-10-06T00:00:00.000Z UTC'), findsOneWidget);
      await tester.tap(find.byKey(const Key('legend_Volume_ETH')));
      await tester.pump();
      await tester.tap(find.byTooltip('Export Volume CSV'));
      await tester.pump();
      expect(copied, contains('9007199254740993.123456'));
      expect(copied, isNot(contains('ETH')));
      await tester.tap(find.byKey(const Key('Volume_area')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('Volume_week')));
      await tester.pump();
      expect(find.byKey(const Key('tooltip_Volume')), findsNothing);
      expect(tester.takeException(), isNull);
      await disposeDashboard(tester);
    });
  }
}
