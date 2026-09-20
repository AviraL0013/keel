import 'package:flutter_test/flutter_test.dart';
import 'package:keel_mobile/features/books/domain/book.dart';
import 'package:keel_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:keel_mobile/features/notifications/domain/notification_item.dart';
import 'package:keel_mobile/features/positions/domain/position.dart';

void main() {
  test('Book configuration rejects unsafe values', () {
    const config = BookConfiguration(liquidationFloor: 6, defenseCap: 100, reserve: 120, timeLimit: Duration(hours: 8), stance: 'DEFEND', automation: false);
    expect(config.validate(), contains('Reserve'));
  });
  test('capital keeps unavailable values unknown', () {
    final capital = CapitalSnapshot.fromJson({'status': 'UNAVAILABLE'});
    expect(capital.ausdBalance, isNull);
    expect(capital.perplAvailable, isNull);
  });
  test('position preserves documented lifecycle status', () {
    final position = Position.fromJson({'marketId': 1, 'accountId': 2, 'market': 'BTC-PERP', 'positionId': 3, 'position': {'side': 'LONG', 'size': 1, 'entryPrice': 100, 'markPrice': 101, 'liquidationPrice': 90, 'leverage': 5, 'margin': 20, 'status': 'DELEVERAGED'}});
    expect(position.status, 'DELEVERAGED');
  });
  test('notification exposes unread state', () {
    final item = NotificationItem.fromJson({'id': '1', 'title': 'Risk', 'body': 'SAFE_MODE', 'kind': 'SAFE_MODE', 'createdAt': '2026-09-20T00:00:00Z'});
    expect(item.unread, isTrue);
  });
}
