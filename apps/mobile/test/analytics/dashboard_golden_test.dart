import 'dart:io';

import 'package:eyeler_mobile/features/analytics/dashboard_screen.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'dashboard_fixture.dart';
import 'dashboard_screen_test.dart' show mountDashboard, disposeDashboard;

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
    for (final (name, section) in [
      ('overview', 0),
      ('volume', 1),
      ('flows', 4),
      ('wallet', -1)
    ]) {
      testWidgets('recorded mainnet $name ${width.toInt()} golden',
          (tester) async {
        final child = section == -1
            ? DashboardWalletProfile(address: RecordedDashboard.wallet)
            : AnalyticsDashboard(initialSection: section);
        await mountDashboard(tester, width, child, RecordedDashboard(),
            height: 1000);
        // Image decoding runs outside Flutter's fake clock. Wait for the real
        // brand asset so the first screenshot does not capture an empty frame.
        await tester.runAsync(() => precacheImage(
            const AssetImage('assets/branding/eyeler-eye.png'),
            tester.element(find.byType(Scaffold).first)));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        await expectLater(
            find.byType(MaterialApp),
            matchesGoldenFile(
                'goldens/redesign/${Platform.isWindows ? 'windows' : 'linux'}/$name-${width.toInt()}.png'));
        await disposeDashboard(tester);
      });
    }
  }
}
