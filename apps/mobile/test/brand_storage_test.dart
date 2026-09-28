import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';

void main() {
  test('migrates same-origin Keel session keys and clears both names', () async {
    FlutterSecureStorage.setMockInitialValues({
      'keel_session_token': 'existing-session',
      'keel_wallet_address': '0xabc',
    });
    const session = SessionStorage();
    const storage = FlutterSecureStorage();
    expect(await session.readToken(), 'existing-session');
    expect(await session.readAddress(), '0xabc');
    expect(await storage.read(key: 'eyeler_session_token'), 'existing-session');
    expect(await storage.read(key: 'keel_session_token'), isNull);
    await session.clear();
    expect(await storage.read(key: 'eyeler_session_token'), isNull);
    expect(await storage.read(key: 'keel_wallet_address'), isNull);
  });

  test('reads a legacy ledger source from an older backend', () {
    final amount = CapitalAmount.fromJson({'amount': '10', 'source': 'KEEL_LEDGER'}, asset: 'AUSD', source: 'EYELER_LEDGER');
    expect(amount.source, 'EYELER_LEDGER');
  });
}
