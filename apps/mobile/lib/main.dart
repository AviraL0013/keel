import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/theme_controller.dart';
import 'features/auth/data/auth_repository.dart';
import 'features/auth/domain/auth_state.dart';
import 'features/landing/presentation/eyeler_landing_page.dart';

void main() => runApp(const ProviderScope(child: EyelerApp()));

class EyelerApp extends ConsumerStatefulWidget {
  const EyelerApp({super.key});
  @override
  ConsumerState<EyelerApp> createState() => _EyelerAppState();
}

class _EyelerAppState extends ConsumerState<EyelerApp> {
  bool _landingComplete = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(() => ref.read(authProvider.notifier).restore());
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'EYELER',
        debugShowCheckedModeBanner: false,
        theme: EyelerTheme.light,
        darkTheme: EyelerTheme.dark,
        themeMode: ref.watch(themeModeProvider),
        home: _landingComplete
            ? _Gate(state: ref.watch(authProvider))
            : EyelerLandingPage(
                onFinished: () {
                  if (mounted) setState(() => _landingComplete = true);
                },
              ),
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
    return EyelerRouter(authenticated: state.authenticated);
  }
}
