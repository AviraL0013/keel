import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SessionStorage {
  const SessionStorage();
  static const _key = 'keel_session_token';
  Future<String?> readToken() => const FlutterSecureStorage().read(key: _key);
  Future<void> saveToken(String token) =>
      const FlutterSecureStorage().write(key: _key, value: token);
  Future<void> clear() => const FlutterSecureStorage().delete(key: _key);
}
