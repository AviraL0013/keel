import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keel_mobile/features/books/presentation/widgets/book_widgets.dart';

void main() {
  testWidgets('risk state and unavailable metrics render clearly', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Column(children: [RiskStateBadge(state: 'SAFE_MODE'), ValueTile(label: 'Funding', value: null)]))));
    expect(find.text('SAFE_MODE'), findsOneWidget);
    expect(find.text('Unavailable'), findsOneWidget);
  });
}
