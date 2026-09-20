import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keel_mobile/core/theme/app_theme.dart';

void main() {
  testWidgets('KEEL theme renders risk control surface', (tester) async {
    await tester.pumpWidget(MaterialApp(theme: KeelTheme.data, home: const Scaffold(body: Text('SAFE_MODE'))));
    expect(find.text('SAFE_MODE'), findsOneWidget);
  });
}
