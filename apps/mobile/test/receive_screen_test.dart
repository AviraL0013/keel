import 'package:eyeler_mobile/features/capital/presentation/receive_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const address = '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F';

void main() {
  for (final width in [320.0, 360.0]) {
    testWidgets('Receive displays full address and QR at ${width.toInt()} dp',
        (tester) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester
          .pumpWidget(const MaterialApp(home: ReceiveScreen(address: address)));
      expect(find.text(address), findsOneWidget);
      expect(find.text('Monad mainnet'), findsOneWidget);
      expect(find.byKey(const Key('receive_qr')), findsOneWidget);
      expect(find.text('COPY ADDRESS'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
