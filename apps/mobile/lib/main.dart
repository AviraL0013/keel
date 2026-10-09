import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/theme_controller.dart';
import 'features/auth/data/auth_repository.dart';
import 'features/auth/domain/auth_state.dart';
import 'features/analytics/analytics_screen.dart';
import 'features/landing/presentation/eyeler_landing_page.dart';
import 'features/onboarding/data/onboarding_repository.dart';

void main() {
  GoogleFonts.config.allowRuntimeFetching = false;
  runApp(const ProviderScope(child: EyelerApp()));
}

class EyelerApp extends ConsumerStatefulWidget {
  const EyelerApp({super.key, this.initialRoute});
  final String? initialRoute;
  @override
  ConsumerState<EyelerApp> createState() => _EyelerAppState();
}

class _EyelerAppState extends ConsumerState<EyelerApp>
    with WidgetsBindingObserver {
  bool _landingComplete = false;
  late final bool _publicAnalytics;
  final _navigator = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _publicAnalytics = (widget.initialRoute ??
            WidgetsBinding.instance.platformDispatcher.defaultRouteName) ==
        '/analytics';
    ref.listenManual(authProvider, (previous, next) {
      if (previous?.authenticated == true &&
          (!next.authenticated || previous?.address != next.address)) {
        // Remove wallet-specific routes as well as clearing provider caches.
        _navigator.currentState?.popUntil((route) => route.isFirst);
      }
    });
    if (!_publicAnalytics) {
      Future.microtask(() => ref.read(authProvider.notifier).restore());
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_publicAnalytics) return;
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.detached) {
      ref.read(walletConnectorProvider).dispose();
    }
    if (state == AppLifecycleState.resumed) refreshOnboarding(ref);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'EYELER',
        navigatorKey: _navigator,
        debugShowCheckedModeBanner: false,
        theme: EyelerTheme.light,
        darkTheme: EyelerTheme.dark,
        themeMode: ref.watch(themeModeProvider),
        initialRoute: widget.initialRoute,
        routes: {'/analytics': (_) => const AnalyticsScreen()},
        onGenerateInitialRoutes: _publicAnalytics
            ? (_) => [
                  MaterialPageRoute<void>(
                      settings: const RouteSettings(name: '/analytics'),
                      builder: (_) => const AnalyticsScreen())
                ]
            : null,
        home: _publicAnalytics
            ? null
            : _landingComplete
                ? _Gate(
                    key: ValueKey((
                      ref.watch(authProvider).authenticated,
                      ref.watch(authProvider).address
                    )),
                    state: ref.watch(authProvider))
                : EyelerLandingPage(
                    onFinished: () {
                      if (mounted) setState(() => _landingComplete = true);
                    },
                  ),
      );
}

class _Gate extends StatelessWidget {
  const _Gate({super.key, required this.state});
  final AuthState state;
  @override
  Widget build(BuildContext context) {
    if (state.restoring) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return EyelerRouter(authenticated: state.authenticated);
  }
}
