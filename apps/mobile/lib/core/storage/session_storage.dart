import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SessionStorage {
  const SessionStorage();
  static const _key = 'keel_session_token';
  static const _addressKey = 'keel_wallet_address';
  Future<String?> readToken() => const FlutterSecureStorage().read(key: _key);
  Future<void> saveToken(String token) =>
      const FlutterSecureStorage().write(key: _key, value: token);
  Future<String?> readAddress() =>
      const FlutterSecureStorage().read(key: _addressKey);
  Future<void> saveAddress(String address) =>
      const FlutterSecureStorage().write(key: _addressKey, value: address);
  Future<void> clear() async {
    const storage = FlutterSecureStorage();
    await storage.delete(key: _key);
    await storage.delete(key: _addressKey);
  }
}
