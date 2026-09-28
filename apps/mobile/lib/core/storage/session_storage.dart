import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SessionStorage {
  const SessionStorage();
  static const _key = 'eyeler_session_token';
  static const _addressKey = 'eyeler_wallet_address';
  static const _oldKey = 'keel_session_token';
  static const _oldAddressKey = 'keel_wallet_address';
  Future<String?> _readAndMigrate(String current, String previous) async {
    const storage = FlutterSecureStorage();
    final value = await storage.read(key: current);
    if (value != null) return value;
    final old = await storage.read(key: previous);
    if (old != null) {
      await storage.write(key: current, value: old);
      await storage.delete(key: previous);
    }
    return old;
  }

  Future<String?> readToken() => _readAndMigrate(_key, _oldKey);
  Future<void> saveToken(String token) async {
    const storage = FlutterSecureStorage();
    await storage.write(key: _key, value: token);
    await storage.delete(key: _oldKey);
  }

  Future<String?> readAddress() => _readAndMigrate(_addressKey, _oldAddressKey);
  Future<void> saveAddress(String address) async {
    const storage = FlutterSecureStorage();
    await storage.write(key: _addressKey, value: address);
    await storage.delete(key: _oldAddressKey);
  }

  Future<void> clear() async {
    const storage = FlutterSecureStorage();
    await storage.delete(key: _key);
    await storage.delete(key: _addressKey);
    await storage.delete(key: _oldKey);
    await storage.delete(key: _oldAddressKey);
  }
}
