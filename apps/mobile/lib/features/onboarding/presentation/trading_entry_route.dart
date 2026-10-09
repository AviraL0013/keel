import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../openings/presentation/opening_screen.dart';
import '../data/onboarding_repository.dart';
import 'onboarding_screen.dart';

/// All app entry points verify setup before presenting opening-order controls.
class TradingEntryRoute extends ConsumerStatefulWidget {
  const TradingEntryRoute({super.key});
  @override
  ConsumerState<TradingEntryRoute> createState() => _TradingEntryRouteState();
}

class _TradingEntryRouteState extends ConsumerState<TradingEntryRoute> {
  bool _checking = true;
  @override
  void initState() {
    super.initState();
    // Wait until the scope is mounted, and hide order controls until fresh
    // evidence arrives even if Home previously cached a ready result.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      refreshOnboarding(ref);
      try {
        await ref.read(onboardingProvider.future);
      } catch (_) {}
      if (mounted) setState(() => _checking = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final progress = ref.watch(onboardingProvider);
    if (_checking) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    return progress.when(
      loading: () =>
          const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (error, _) => OnboardingScreen(error: error),
      data: (progress) => progress.canOpenTrade
          ? const OpeningScreen()
          : OnboardingScreen(progress: progress),
    );
  }
}
