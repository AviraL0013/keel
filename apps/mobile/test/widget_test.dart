import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';

void main() {
  testWidgets('EYELER theme renders risk control surface', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: EyelerTheme.data, home: const Scaffold(body: Text('SAFE_MODE'))));
    expect(find.text('SAFE_MODE'), findsOneWidget);
  });
}
