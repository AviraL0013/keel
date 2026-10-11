import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/features/analytics/analytics_models.dart';
import 'package:eyeler_mobile/features/analytics/analytics_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('recorded mainnet closes have axes and accessible exact values',
      (tester) async {
    final recorded = jsonDecode(
        File('test/analytics/fixtures/perpl-mainnet-btc-2026-10-05.json')
            .readAsStringSync()) as Map<String, dynamic>;
    final candles = (recorded['candles'] as List<dynamic>).take(2).toList();
    final points = [
      for (final raw in candles)
        AnalyticsPoint(
          DateTime.fromMillisecondsSinceEpoch(raw['t'] as int, isUtc: true),
          ((raw['c'] as int) / 10).toStringAsFixed(1),
        ),
    ];
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(body: AnalyticsChart(points: points, label: 'Price'))));
    expect(find.text(AnalyticsNumbers.compact(points.first.value, places: 2)),
        findsOneWidget);
    expect(find.text(AnalyticsNumbers.compact(points.last.value, places: 2)),
        findsOneWidget);
    final chart =
        find.semantics.byLabel(RegExp('Price chart, 2 observed values'));
    expect(chart, findsOneWidget);
    tester.semantics.performAction(chart, SemanticsAction.increase);
    await tester.pump();
    expect(find.textContaining(points.first.value!), findsOneWidget);
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });

  for (final width in [320.0, 1280.0]) {
    testWidgets('chart tap reveals exact values at ${width.toInt()}dp',
        (tester) async {
      tester.view.physicalSize = Size(width, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: AnalyticsChart(points: [
            AnalyticsPoint(DateTime.utc(2026, 10, 7, 12), '1.000000'),
            AnalyticsPoint(DateTime.utc(2026, 10, 7, 13), null),
            AnalyticsPoint(
                DateTime.utc(2026, 10, 7, 14), '12345678901234567890.123456'),
          ]),
        ),
      ));
      final chart = tester.getRect(find.byType(AnalyticsChart));
      await tester.tapAt(Offset(chart.right - 2, chart.top + 70));
      await tester.pump();
      expect(
          find.textContaining('12345678901234567890.123456'), findsOneWidget);
      expect(
          find.textContaining(analyticsLocalTime(DateTime.utc(2026, 10, 7, 14),
              tester.element(find.byType(AnalyticsChart)))),
          findsOneWidget);
      await tester.tapAt(Offset(chart.center.dx, chart.top + 70));
      await tester.pump();
      expect(find.textContaining('12345678901234567890.123456'), findsNothing);
    });
  }

  testWidgets('new timeframe clears a selected value', (tester) async {
    Widget chart(List<AnalyticsPoint> points) => MaterialApp(
          home: Scaffold(body: AnalyticsChart(points: points)),
        );
    await tester.pumpWidget(chart([
      AnalyticsPoint(DateTime.utc(2026, 10, 7, 12), '1.000000'),
    ]));
    final rect = tester.getRect(find.byType(AnalyticsChart));
    await tester.tapAt(rect.center);
    await tester.pump();
    expect(find.textContaining('1.000000'), findsOneWidget);
    await tester.pumpWidget(chart([
      AnalyticsPoint(DateTime.utc(2026, 10, 8, 12), '2.000000'),
    ]));
    await tester.pump();
    expect(find.textContaining('1.000000'), findsNothing);
    expect(find.textContaining('2.000000'), findsNothing);
  });
}
