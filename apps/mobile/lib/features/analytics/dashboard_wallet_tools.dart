import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'analytics_contract.dart';
import 'dashboard_wallet.dart';
import 'dashboard_wallet_insights.dart';
import 'dashboard_wallet_stress.dart';
import 'dashboard_wallet_tools_data.dart';
import 'dashboard_wallet_watch.dart';

/// One mount for insights, stress preview, and active-session wallet watch.
class DashboardWalletTools extends ConsumerStatefulWidget {
  const DashboardWalletTools({super.key, required this.address});
  final String address;

  @override
  ConsumerState<DashboardWalletTools> createState() =>
      _DashboardWalletToolsState();
}

class _DashboardWalletToolsState extends ConsumerState<DashboardWalletTools>
    with WidgetsBindingObserver {
  late WalletWatchSession watch = WalletWatchSession(widget.address);
  Timer? timer;
  bool refreshing = false;
  int generation = 0;
  V1Envelope<DashboardWalletData>? lastSnapshot;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didUpdateWidget(DashboardWalletTools oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.address.toLowerCase() != widget.address.toLowerCase()) {
      generation++;
      timer?.cancel();
      watch = WalletWatchSession(widget.address);
      lastSnapshot = null;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed && watch.active) {
      _pause();
    }
  }

  @override
  void dispose() {
    generation++;
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _schedule() {
    timer?.cancel();
    if (!watch.active) return;
    timer = Timer(const Duration(seconds: 30), () => unawaited(_poll()));
  }

  Future<void> _poll() async {
    if (!mounted || !watch.active || refreshing) return;
    final currentGeneration = generation;
    refreshing = true;
    try {
      final provider = dashboardWalletProvider(widget.address);
      ref.invalidate(provider);
      final response = await ref.read(provider.future);
      if (!mounted || !watch.active || currentGeneration != generation) return;
      setState(() {
        lastSnapshot = response;
        watch.accept(response);
      });
    } catch (_) {
      if (!mounted || !watch.active || currentGeneration != generation) return;
      setState(() => watch.gap('Snapshot refresh failed.'));
    } finally {
      refreshing = false;
      if (mounted && watch.active) {
        if (currentGeneration == generation) {
          _schedule();
        } else {
          unawaited(_poll());
        }
      }
    }
  }

  void _start() {
    generation++;
    timer?.cancel();
    setState(() => watch.start(lastSnapshot));
    if (watch.baseline == null) {
      unawaited(_poll());
    } else {
      _schedule();
    }
  }

  void _pause() {
    generation++;
    timer?.cancel();
    setState(watch.pause);
  }

  void _resume() {
    generation++;
    timer?.cancel();
    setState(watch.resume);
    unawaited(_poll());
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(dashboardWalletProvider(widget.address));
    final activity = ref.watch(dashboardWalletActivityProvider(widget.address));
    final value = profile.asData?.value;
    if (value != null) lastSnapshot = value;
    final snapshot = profile.hasError ? null : value ?? lastSnapshot;
    final verified = snapshot != null &&
        walletSnapshotReason(snapshot, widget.address) == null;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      PositionInsightsPanel(
        profile: verified ? snapshot.data : null,
        activity: activity.asData?.value.data,
      ),
      const SizedBox(height: 16),
      WalletStressPanel(snapshot: snapshot),
      const SizedBox(height: 16),
      LiveWalletWatchPanel(
          session: watch, onStart: _start, onPause: _pause, onResume: _resume),
    ]);
  }
}
