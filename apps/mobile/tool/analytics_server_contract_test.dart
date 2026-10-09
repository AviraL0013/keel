import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/features/analytics/analytics_repository.dart';
import 'package:eyeler_mobile/features/analytics/public_analytics_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

// Explicit integration command; Node and Flutter SDKs must both be installed.
// Starts only a loopback replay server. No real RPC, order or wallet operation.
void main() {
  test('Flutter consumes recorded data through the fully registered local API',
      () async {
    const address = '0x5D8FfA5F7c6A42470B4eC61a8CdAbB799fd3765A';
    final root = Directory.current.parent.parent.path;
    final process = await Process.start(
        'node', ['--import', 'tsx', 'tests/helpers/analytics-server.ts'],
        workingDirectory: root);
    final stderr = StringBuffer();
    final errors = process.stderr.transform(utf8.decoder).listen(stderr.write);
    final ready = Completer<String>();
    final output = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
      if (line.startsWith('http://127.0.0.1:') && !ready.isCompleted) {
        ready.complete(line);
      }
    });
    final client = http.Client();
    try {
      final base = await ready.future.timeout(const Duration(seconds: 30),
          onTimeout: () => throw StateError('Replay server failed: $stderr'));
      final transport = PublicAnalyticsClient(base, client);
      final repository = HttpAnalyticsRepository(transport.get,
          now: () => DateTime.parse('2026-10-07T17:00:00.123456Z'));
      final overview = await repository.overview();
      expect(overview.markets.map((item) => item.symbol), contains('BTC'));
      expect(overview.stale, isTrue);
      expect(overview.historyLabels['All'], contains('history incomplete'));
      expect(
          overview.windows['All']!
              .firstWhere((item) => item.key == 'volume')
              .value,
          isNull);
      final market = await repository.market('BTC', '24h');
      expect(market.symbol, 'BTC');
      expect(market.priceSeries.first.at,
          DateTime.parse('2026-10-06T18:00:00.000Z'));
      expect(market.priceSeries.first.value, '85524.4');
      expect(market.priceSeries.last.value, isNull);
      expect(market.stale, isTrue);
      final wallet = await repository.wallet(address);
      expect(wallet.margin.balance, '1412227.132218');
      expect(wallet.margin.locked, '366352.546064');
      expect(wallet.margin.available, '1045874.586154');
      expect(wallet.positions.single.unrealizedPnl, '-1.609876');
      expect(wallet.positions.single.side, 'short');
      expect(wallet.positions.single.entry, '5.15296234588623046875');
      expect(wallet.margin.equity, isNull);
      expect(wallet.positions.single.liquidationPrice, isNull);
      expect(wallet.performance.winRate, isNull);
      expect(wallet.stale, isTrue);
      expect(await repository.search(address), [address]);
      final trades = await repository.trades(address);
      expect(trades.rows,
          isEmpty); // No creation history is invented for this wallet.
      final blocked = await client.get(Uri.parse('$base/books'));
      expect(blocked.statusCode, 401);
      expect(jsonDecode(blocked.body)['error'], 'UNAUTHENTICATED');
      await expectLater(transport.get('/books'), throwsFormatException);
    } finally {
      client.close();
      process.kill();
      await process.exitCode.timeout(const Duration(seconds: 10));
      await output.cancel();
      await errors.cancel();
    }
  }, timeout: const Timeout(Duration(seconds: 90)));
}
