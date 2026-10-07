import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'analytics_models.dart';

abstract interface class AnalyticsLocalStore {
  Future<List<String>> watchlist();
  Future<List<String>> recent();
  Future<void> setWatchlist(List<String> addresses);
  Future<void> addRecent(String address);
}

class SecureAnalyticsLocalStore implements AnalyticsLocalStore {
  const SecureAnalyticsLocalStore(this.storage);
  final FlutterSecureStorage storage;
  static const _watchlistKey = 'analytics_watchlist_v1';
  static const _recentKey = 'analytics_recent_v1';

  Future<List<String>> _read(String key) async {
    final raw = await storage.read(key: key);
    if (raw == null) return [];
    final value = jsonDecode(raw);
    if (value is! List) return [];
    return value.whereType<String>().where(isAnalyticsAddress).toList();
  }

  @override
  Future<List<String>> watchlist() => _read(_watchlistKey);
  @override
  Future<List<String>> recent() => _read(_recentKey);

  @override
  Future<void> setWatchlist(List<String> addresses) async {
    if (addresses.length > 4 || addresses.any((a) => !isAnalyticsAddress(a))) {
      throw const FormatException('Watchlist accepts up to four addresses');
    }
    await storage.write(key: _watchlistKey, value: jsonEncode(addresses));
  }

  @override
  Future<void> addRecent(String address) async {
    if (!isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    final previous = await recent();
    final next = [
      address,
      ...previous.where((a) => a.toLowerCase() != address.toLowerCase()),
    ].take(8).toList();
    await storage.write(key: _recentKey, value: jsonEncode(next));
  }
}

class MemoryAnalyticsLocalStore implements AnalyticsLocalStore {
  List<String> saved = [];
  List<String> searched = [];
  @override
  Future<List<String>> watchlist() async => List.of(saved);
  @override
  Future<List<String>> recent() async => List.of(searched);
  @override
  Future<void> setWatchlist(List<String> addresses) async {
    if (addresses.length > 4 || addresses.any((a) => !isAnalyticsAddress(a))) {
      throw const FormatException('Watchlist accepts up to four addresses');
    }
    saved = List.of(addresses);
  }

  @override
  Future<void> addRecent(String address) async {
    if (!isAnalyticsAddress(address)) {
      throw const FormatException('Invalid address');
    }
    searched = [
      address,
      ...searched.where((a) => a.toLowerCase() != address.toLowerCase()),
    ].take(8).toList();
  }
}

final analyticsLocalStoreProvider = Provider<AnalyticsLocalStore>(
  (_) => const SecureAnalyticsLocalStore(FlutterSecureStorage()),
);
