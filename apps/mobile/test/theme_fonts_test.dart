import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

void main() {
  testWidgets('both themes load every Manrope variant without network access',
      (tester) async {
    final previous = GoogleFonts.config.allowRuntimeFetching;
    GoogleFonts.config.allowRuntimeFetching = false;
    addTearDown(() => GoogleFonts.config.allowRuntimeFetching = previous);
    for (final dark in [false, true]) {
      late ThemeData theme;
      await tester.runAsync(() async {
        theme = dark ? EyelerTheme.dark : EyelerTheme.light;
        await GoogleFonts.pendingFonts();
      });
      await tester.pumpWidget(MaterialApp(
          theme: theme,
          home: const Scaffold(body: Text('Offline typography'))));
      await tester.pump();
      expect(tester.takeException(), isNull);
    }
  });
}
