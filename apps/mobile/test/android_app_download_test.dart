import 'package:eyeler_mobile/shared/widgets/android_app_download.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final width in [360.0, 1280.0]) {
    testWidgets('Android install instructions and download fit $width px',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 900);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final launched = <Uri>[];
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Center(
            child: AndroidAppDownload(launcher: (uri) async {
              launched.add(uri);
              return true;
            }),
          ),
        ),
      ));
      await tester.tap(find.text('Download Android app'));
      await tester.pumpAndSettle();
      expect(find.text('Install Eyeler on Android'), findsOneWidget);
      expect(find.textContaining('Android phones only'), findsOneWidget);
      expect(find.textContaining('allow installation'), findsOneWidget);
      expect(launched, isEmpty);
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('Download APK'));
      await tester.pumpAndSettle();
      expect(launched, [Uri.parse(androidAppDownloadUrl)]);
      expect(launched.single.scheme, 'https');
      expect(launched.single.host, 'github.com');
      expect(launched.single.query, isEmpty);
      expect(find.text('Install Eyeler on Android'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('compact control opens instructions without starting download',
      (tester) async {
    var calls = 0;
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: AndroidAppDownload(
      compact: true,
      launcher: (_) async {
        calls++;
        return true;
      },
    ))));
    await tester.tap(find.byTooltip('Download Android app'));
    await tester.pumpAndSettle();
    expect(find.text('Install Eyeler on Android'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(calls, 0);
    expect(find.text('Install Eyeler on Android'), findsNothing);
  });

  for (final throwsError in [false, true]) {
    testWidgets('download failure shows safe retry message ($throwsError)',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
          home: Scaffold(body: AndroidAppDownload(launcher: (_) async {
        if (throwsError) throw StateError('private transport diagnostic');
        return false;
      }))));
      await tester.tap(find.text('Download Android app'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Download APK'));
      await tester.pumpAndSettle();
      expect(find.text('Could not open the Android download. Please retry.'),
          findsOneWidget);
      expect(find.textContaining('private transport'), findsNothing);
      expect(find.text('Download APK'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
