import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/theme_controller.dart';
import 'features/auth/data/auth_repository.dart';
import 'features/auth/domain/auth_state.dart';

void main() => runApp(const ProviderScope(child: KeelApp()));

class KeelApp extends ConsumerStatefulWidget {
  const KeelApp({super.key});
  @override
  ConsumerState<KeelApp> createState() => _KeelAppState();
}

class _KeelAppState extends ConsumerState<KeelApp> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => ref.read(authProvider.notifier).restore());
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'KEEL',
        debugShowCheckedModeBanner: false,
        theme: KeelTheme.light,
        darkTheme: KeelTheme.dark,
        themeMode: ref.watch(themeModeProvider),
        home: _Gate(state: ref.watch(authProvider)),
      );
}

class _Gate extends StatelessWidget {
  const _Gate({required this.state});
  final AuthState state;
  @override
  Widget build(BuildContext context) {
    if (state.restoring) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return KeelRouter(authenticated: state.authenticated);
  }
}
