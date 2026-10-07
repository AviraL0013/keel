import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/features/analytics/analytics_contract.dart';
import 'package:flutter_test/flutter_test.dart';

Object fixture(String name) =>
    jsonDecode(File('test/fixtures/analytics/_$name.json').readAsStringSync());

void main() {
  test('parses every published endpoint fixture and envelope', () {
    final summary = V1Envelope.fromJson(
        fixture('protocol_summary'), V1ProtocolSummary.fromJson);
    expect(summary.data.metrics['activeUsers']!.value, '120');
    expect(summary.block, 35000000);
    expect(summary.stale, isFalse);
    expect(
        V1Envelope.fromJson(
                fixture('protocol_timeseries'), V1Timeseries.fromJson)
            .data
            .points,
        hasLength(2));
    expect(
        V1Envelope.fromJson(fixture('protocol_flows'), V1Flows.fromJson)
            .data
            .buckets
            .first
            .net,
        '3000.000000');
    expect(
        V1Envelope.fromJson(
                fixture('markets'),
                (raw) => V1.list(
                    raw as Map<String, dynamic>, 'items', V1Market.fromJson))
            .data
            .first
            .id,
        1);
    expect(
        V1Envelope.fromJson(fixture('markets_id'), V1MarketDetail.fromJson)
            .data
            .fundingIntervalSeconds,
        3600);
    expect(
        V1Envelope.fromJson(
                fixture('markets_id_funding'), V1MarketFunding.fromJson)
            .data
            .points
            .first
            .rate,
        '0.000012');
    expect(
        V1Envelope.fromJson(fixture('liquidations'), V1LiquidationPage.fromJson)
            .data
            .count,
        1);
    expect(V1Envelope.fromJson(fixture('search'), V1Search.fromJson).data.items,
        hasLength(1));
    expect(
        V1Envelope.fromJson(
                fixture('wallets_address'), V1WalletProfile.fromJson)
            .data
            .positions
            .first
            .liquidationPrice,
        '82000.0');
    expect(
        V1Envelope.fromJson(
                fixture('wallets_address_trades'), V1TradePage.fromJson)
            .data
            .items
            .first
            .realizedPnl,
        '125.000000');
    expect(
        V1Envelope.fromJson(fixture('wallets_address_performance'),
                V1WalletPerformance.fromJson)
            .data
            .winRatePct,
        '60.00');
    expect(
        V1Envelope.fromJson(
                fixture('wallets_compare'), V1WalletCompare.fromJson)
            .data
            .wallets,
        hasLength(1));
  });

  test('preserves null as unavailable and rejects numeric money', () {
    final raw = jsonDecode(jsonEncode(fixture('protocol_summary')))
        as Map<String, dynamic>;
    final data = raw['data'] as Map<String, dynamic>;
    (data['volume'] as Map<String, dynamic>)['value'] = null;
    expect(
        V1Envelope.fromJson(raw, V1ProtocolSummary.fromJson)
            .data
            .metrics['volume']!
            .value,
        isNull);
    (data['volume'] as Map<String, dynamic>)['value'] = 0;
    expect(() => V1Envelope.fromJson(raw, V1ProtocolSummary.fromJson),
        throwsFormatException);
  });

  test('rejects wrong envelope source and malformed timestamps', () {
    final raw =
        jsonDecode(jsonEncode(fixture('markets'))) as Map<String, dynamic>;
    raw['source'] = 'unknown';
    expect(
        () => V1Envelope.fromJson(raw, (data) => data), throwsFormatException);
    raw['source'] = 'perpl_api';
    raw['asOf'] = '2026-10-07';
    expect(
        () => V1Envelope.fromJson(raw, (data) => data), throwsFormatException);
    raw['asOf'] = '2026-02-30T12:00:00Z';
    expect(
        () => V1Envelope.fromJson(raw, (data) => data), throwsFormatException);
  });
}
