import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/analytics/analytics_local_store.dart';
import 'package:eyeler_mobile/features/analytics/analytics_models.dart';
import 'package:eyeler_mobile/features/analytics/analytics_repository.dart';
import 'package:eyeler_mobile/features/analytics/analytics_screen.dart';
import 'package:eyeler_mobile/features/analytics/wallet_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const address = '0x0000000000000000000000000000000000000001';
final fixture =
    jsonDecode(File('test/fixtures/analytics/sample.json').readAsStringSync())
        as Map<String, dynamic>;

enum ViewState { loading, empty, error, stale, loaded }

class StateRepository implements AnalyticsRepository {
  StateRepository(this.state);
  final ViewState state;
  final pending = Completer<void>();

  @override
  Future<List<String>> search(String query) async =>
      [address].where((item) => item.startsWith(query)).toList();

  Map<String, dynamic> _copy() =>
      jsonDecode(jsonEncode(fixture)) as Map<String, dynamic>;

  Future<T> _result<T>(T Function(Map<String, dynamic>) build) async {
    if (state == ViewState.loading) await pending.future;
    if (state == ViewState.error) throw StateError('offline');
    return build(_copy());
  }

  @override
  Future<AnalyticsOverview> overview() => _result((root) {
        final json = root['overview'] as Map<String, dynamic>;
        json['asOf'] = state == ViewState.stale
            ? '2020-01-01T00:00:00Z'
            : '2100-01-01T00:00:00Z';
        if (state == ViewState.empty) {
          final windows = json['windows'] as Map<String, dynamic>;
          for (final key in windows.keys) {
            windows[key] = [];
          }
          json['markets'] = [];
          json['volumeSeries'] = [];
          json['inflowSeries'] = [];
          json['liquidations'] = [];
        }
        return AnalyticsOverview.fromJson(json);
      });

  @override
  Future<AnalyticsMarketDetail> market(String symbol, String window) =>
      _result((root) {
        final json = (root['marketDetails'] as Map<String, dynamic>)['BTC-PERP']
            as Map<String, dynamic>;
        json['asOf'] = state == ViewState.stale
            ? '2020-01-01T00:00:00Z'
            : '2100-01-01T00:00:00Z';
        if (state == ViewState.empty) {
          json['priceSeries'] = [];
          json['fundingHistory'] = [];
          json['liquidations'] = [];
          json['longShare'] = null;
        }
        return AnalyticsMarketDetail.fromJson(json);
      });

  @override
  Future<AnalyticsWallet> wallet(String address) => _result((root) {
        final json = (root['wallets'] as Map<String, dynamic>)[
                '0x0000000000000000000000000000000000000001']
            as Map<String, dynamic>;
        json['asOf'] = state == ViewState.stale
            ? '2020-01-01T00:00:00Z'
            : '2100-01-01T00:00:00Z';
        if (state == ViewState.empty) {
          json['positions'] = [];
          (json['performance'] as Map<String, dynamic>)['equitySeries'] = [];
          final margin = json['margin'] as Map<String, dynamic>;
          margin['equity'] = null;
          margin['available'] = null;
          margin['maintenance'] = null;
        }
        return AnalyticsWallet.fromJson(json);
      });

  @override
  Future<AnalyticsTradePage> trades(String address, {String? cursor}) =>
      _result((root) => AnalyticsTradePage.fromJson((root['trades'] as Map<
          String, dynamic>)['0x0000000000000000000000000000000000000001']));
}

class ErrorStore extends MemoryAnalyticsLocalStore {
  @override
  Future<List<String>> watchlist() => Future.error(StateError('storage'));
}

class CountingRepository extends StateRepository {
  CountingRepository() : super(ViewState.loaded);
  int calls = 0;
  @override
  Future<AnalyticsOverview> overview() {
    calls++;
    return super.overview();
  }
}

class PagedRepository extends StateRepository {
  PagedRepository() : super(ViewState.loaded);
  int calls = 0;
  @override
  Future<AnalyticsTradePage> trades(String address, {String? cursor}) async {
    calls++;
    return cursor == null
        ? AnalyticsTradePage([
            AnalyticsTrade('first', DateTime.utc(2026, 10, 7), 'BTC-PERP',
                'long', '0.1', '10.00')
          ], 'more')
        : AnalyticsTradePage([
            AnalyticsTrade('second', DateTime.utc(2026, 10, 6), 'BTC-PERP',
                'short', '0.2', '-12.34')
          ], null);
  }
}

Future<void> mount(WidgetTester tester, Size size, Widget screen,
    StateRepository repository, AnalyticsLocalStore store) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  await tester.pumpWidget(ProviderScope(
      overrides: [
        analyticsRepositoryProvider.overrideWithValue(repository),
        analyticsLocalStoreProvider.overrideWithValue(store),
      ],
      child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: EyelerTheme.dark.copyWith(
            textTheme: EyelerTheme.dark.textTheme
                .apply(fontFamily: 'AnalyticsTestRoboto'),
            appBarTheme: EyelerTheme.dark.appBarTheme.copyWith(
                titleTextStyle: EyelerTheme.dark.appBarTheme.titleTextStyle
                    ?.copyWith(fontFamily: 'AnalyticsTestRoboto')),
            outlinedButtonTheme: OutlinedButtonThemeData(
                style: EyelerTheme.dark.outlinedButtonTheme.style?.copyWith(
                    textStyle: WidgetStatePropertyAll(EyelerTypography.label
                        .copyWith(fontFamily: 'AnalyticsTestRoboto')))),
          ),
          home: screen)));
  await tester.pump();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    for (final (family, file) in [
      ('AnalyticsTestRoboto', 'roboto-regular.ttf'),
      ('MaterialIcons', 'MaterialIcons-Regular.otf'),
    ]) {
      final bytes = await File('test/fixtures/analytics/$file').readAsBytes();
      await (FontLoader(family)
            ..addFont(Future.value(ByteData.sublistView(bytes))))
          .load();
    }
  });
  for (final width in [320.0, 360.0, 412.0, 1280.0]) {
    final size = Size(width, 860);
    for (final state in ViewState.values) {
      for (final screen in ['protocol', 'market', 'wallet', 'watchlist']) {
        testWidgets('$screen $state at ${width.toInt()}dp', (tester) async {
          addTearDown(tester.view.resetPhysicalSize);
          addTearDown(tester.view.resetDevicePixelRatio);
          final repository = StateRepository(state);
          final store = state == ViewState.error
              ? ErrorStore()
              : MemoryAnalyticsLocalStore();
          if (screen == 'watchlist' && state != ViewState.empty) {
            store.saved = [address];
          }
          final widget = switch (screen) {
            'protocol' => const Scaffold(body: ProtocolOverviewScreen()),
            'market' => const AnalyticsMarketScreen(symbol: 'BTC-PERP'),
            'wallet' => const AnalyticsWalletScreen(address: address),
            _ => const Scaffold(body: AnalyticsWatchlistScreen()),
          };
          await mount(tester, size, widget, repository, store);
          if (state == ViewState.loading) {
            expect(find.bySemanticsLabel('Loading analytics'), findsWidgets);
          } else if (state == ViewState.error) {
            expect(find.textContaining('unavailable'), findsWidgets);
          } else if (state == ViewState.empty) {
            expect(find.textContaining('No '), findsWidgets);
          } else if (state == ViewState.stale) {
            expect(find.textContaining('Stale'), findsWidgets);
          } else {
            expect(
                find.textContaining('Updated').evaluate().isNotEmpty ||
                    find.textContaining('current').evaluate().isNotEmpty,
                isTrue);
          }
          expect(tester.takeException(), isNull);
        });
      }
    }
  }

  testWidgets('address and market drill down, search validation, and tabs',
      (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await mount(tester, const Size(360, 860), const AnalyticsScreen(),
        StateRepository(ViewState.loaded), MemoryAnalyticsLocalStore());
    await tester.drag(find.byType(ListView).first, const Offset(0, -900));
    await tester.pumpAndSettle();
    await tester.tap(find.text('BTC-PERP').first);
    await tester.pumpAndSettle();
    expect(find.text('Price'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView).first, const Offset(0, -900));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('0x0000').first);
    await tester.pumpAndSettle();
    expect(find.text('Open positions'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Wallet').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'bad');
    await tester.tap(find.byTooltip('Search wallet'));
    await tester.pump();
    expect(find.textContaining('six hexadecimal'), findsOneWidget);
  });

  testWidgets('prefix search opens wallet and saves it for comparison',
      (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryAnalyticsLocalStore();
    await mount(tester, const Size(360, 860), const AnalyticsScreen(),
        StateRepository(ViewState.loaded), store);
    await tester.tap(find.text('Wallet').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '0x000000');
    await tester.tap(find.byTooltip('Search wallet'));
    await tester.pumpAndSettle();
    expect(find.text('Search results'), findsOneWidget);
    await tester.tap(find.textContaining('0x0000').last);
    await tester.pumpAndSettle();
    expect(find.text('Open positions'), findsOneWidget);
    await tester.tap(find.byTooltip('Save wallet'));
    await tester.pump();
    expect(await store.watchlist(), [address]);
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Watchlist').first);
    await tester.pumpAndSettle();
    expect(find.text('1/4 wallets saved'), findsOneWidget);
  });

  testWidgets('watchlist compares four wallets on desktop', (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = MemoryAnalyticsLocalStore()
      ..saved = [
        for (var index = 1; index <= 4; index++)
          '0x${index.toRadixString(16).padLeft(40, '0')}'
      ];
    await mount(
        tester,
        const Size(1280, 860),
        const Scaffold(body: AnalyticsWatchlistScreen()),
        StateRepository(ViewState.loaded),
        store);
    expect(find.text('4/4 wallets saved'), findsOneWidget);
    expect(find.text('Win rate'), findsNWidgets(4));
    expect(tester.takeException(), isNull);
  });

  testWidgets('polling pauses in background and resumes in foreground',
      (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final repository = CountingRepository();
    await mount(
        tester,
        const Size(360, 860),
        const Scaffold(body: ProtocolOverviewScreen()),
        repository,
        MemoryAnalyticsLocalStore());
    expect(repository.calls, 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 16));
    expect(repository.calls, 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(repository.calls, 2);
  });

  testWidgets('wallet trade history loads next page near scroll end',
      (tester) async {
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final repository = PagedRepository();
    await mount(
        tester,
        const Size(360, 860),
        const AnalyticsWalletScreen(address: address),
        repository,
        MemoryAnalyticsLocalStore());
    expect(repository.calls, 1);
    await tester.drag(find.byType(ListView).first, const Offset(0, -1400));
    await tester.pumpAndSettle();
    expect(repository.calls, 2);
    expect(find.text(r'-$12.3'), findsOneWidget);
  });

  for (final width in [360.0, 1280.0]) {
    for (final screen in ['protocol', 'market', 'wallet', 'watchlist']) {
      testWidgets('$screen ${width.toInt()}dp screenshot', (tester) async {
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final store = MemoryAnalyticsLocalStore()
          ..saved = screen == 'watchlist' && width == 1280
              ? [
                  for (var index = 1; index <= 4; index++)
                    '0x${index.toRadixString(16).padLeft(40, '0')}'
                ]
              : [address];
        final widget = switch (screen) {
          'protocol' => const Scaffold(body: ProtocolOverviewScreen()),
          'market' => const AnalyticsMarketScreen(symbol: 'BTC-PERP'),
          'wallet' => const AnalyticsWalletScreen(address: address),
          _ => const Scaffold(body: AnalyticsWatchlistScreen()),
        };
        await mount(tester, Size(width, 860), widget,
            StateRepository(ViewState.loaded), store);
        await tester.pumpAndSettle();
        await expectLater(find.byType(MaterialApp),
            matchesGoldenFile('goldens/$screen-${width.toInt()}.png'));
      });
    }
  }
  for (final (name, widget) in [
    ('analytics', const AnalyticsScreen()),
    ('search', const Scaffold(body: AnalyticsWalletSearchScreen())),
  ]) {
    testWidgets('$name 360dp screenshot', (tester) async {
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await mount(tester, const Size(360, 860), widget,
          StateRepository(ViewState.loaded), MemoryAnalyticsLocalStore());
      await tester.pumpAndSettle();
      await expectLater(
          find.byType(MaterialApp), matchesGoldenFile('goldens/$name-360.png'));
    });
  }
}
