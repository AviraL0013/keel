import 'package:flutter_test/flutter_test.dart';
import 'package:keel_mobile/features/books/domain/book.dart';
import 'package:keel_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:keel_mobile/features/notifications/domain/notification_item.dart';
import 'package:keel_mobile/features/positions/domain/position.dart';

void main() {
  test('Book configuration rejects unsafe values', () {
    const config = BookConfiguration(liquidationFloor: 6, defenseCap: 100, reserve: 50, timeLimit: Duration(hours: 8), stance: 'DEFEND', automation: false);
    expect(config.validate(), 'Defense cap cannot exceed reserve.');
  });
  test('Book configuration allows reserve above single-defense cap', () {
    const config = BookConfiguration(liquidationFloor: 6, defenseCap: 5, reserve: 10, timeLimit: Duration(hours: 24), stance: 'DEFEND', automation: false);
    expect(config.validate(), isNull);
  });
  test('Book configuration rejects defense cap above reserve', () {
    const config = BookConfiguration(liquidationFloor: 6, defenseCap: 10, reserve: 5, timeLimit: Duration(hours: 24), stance: 'DEFEND', automation: false);
    expect(config.validate(), 'Defense cap cannot exceed reserve.');
  });
  test('capital keeps unavailable values unknown', () {
    final capital = CapitalSnapshot.fromJson({'status': 'UNAVAILABLE'});
    expect(capital.ausdBalance, isNull);
    expect(capital.perplAvailable.amount, isNull);
  });
  test('capital preserves normalized amount metadata', () {
    final capital = CapitalSnapshot.fromJson({
      'status': 'VALID',
      'accountId': 642,
      'perplAvailable': {
        'amount': '99.457410',
        'asset': 'AUSD',
        'decimals': 6,
        'source': 'PERPL_COLLATERAL',
        'availability': 'AVAILABLE',
        'freshness': 'STALE',
        'ageMs': 12000,
      },
    });
    expect(capital.accountId, 642);
    expect(capital.perplAvailable.amount, '99.457410');
    expect(capital.perplAvailable.decimals, 6);
    expect(capital.perplAvailable.source, 'PERPL_COLLATERAL');
    expect(capital.perplAvailable.freshness, 'STALE');
    expect(capital.perplAvailable.ageMs, 12000);
  });
  test('position preserves documented lifecycle status', () {
    final position = Position.fromJson({'marketId': 1, 'accountId': 2, 'market': 'BTC-PERP', 'positionId': 3, 'position': {'side': 'LONG', 'size': 1, 'entryPrice': 100, 'markPrice': 101, 'liquidationPrice': 90, 'leverage': 5, 'margin': 20, 'status': 'DELEVERAGED'}});
    expect(position.status, 'DELEVERAGED');
  });
  test('position parses typed Book creation readiness from the API', () {
    final position = Position.fromJson({
      'marketId': 1,
      'accountId': 642,
      'market': 'BTC-PERP',
      'positionId': 3,
      'position': {
        'side': 'LONG',
        'size': 0.0001,
        'entryPrice': 80599.3,
        'markPrice': 81125.4,
        'liquidationPrice': 78449.99,
        'leverage': 15,
        'margin': 0.54,
        'status': 'OPEN',
      },
      'bookCreation': {
        'allowed': true,
        'code': 'READY',
        'reason': 'Live market and position telemetry are within the configured safety threshold.',
        'market': {
          'status': 'FRESH',
          'updatedAt': 1789966135000,
          'ageMs': 4876,
          'thresholdMs': 10000,
        },
        'position': {
          'status': 'FRESH',
          'updatedAt': 1789966139422,
          'ageMs': 454,
          'thresholdMs': 10000,
        },
      },
    });

    expect(position.bookCreation?.allowed, isTrue);
    expect(position.bookCreation?.code, 'READY');
    expect(position.bookCreation?.market.fresh, isTrue);
    expect(position.bookCreation?.position.ageMs, 454);
  });
  test('notification exposes unread state', () {
    final item = NotificationItem.fromJson({'id': '1', 'title': 'Risk', 'body': 'SAFE_MODE', 'kind': 'SAFE_MODE', 'createdAt': '2026-09-20T00:00:00Z'});
    expect(item.unread, isTrue);
  });
}
