import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import 'analytics_models.dart';

typedef AnalyticsBody<T> = Widget Function(
  BuildContext context,
  T value,
  Future<void> Function() refresh,
);

class AnalyticsResource<T> extends StatefulWidget {
  const AnalyticsResource({
    super.key,
    required this.load,
    required this.body,
    required this.isEmpty,
    required this.asOf,
    this.isStale,
    this.emptyMessage = 'No data yet',
  });
  final Future<T> Function() load;
  final AnalyticsBody<T> body;
  final bool Function(T) isEmpty;
  final DateTime Function(T) asOf;
  final bool Function(T)? isStale;
  final String emptyMessage;

  @override
  State<AnalyticsResource<T>> createState() => _AnalyticsResourceState<T>();
}

class _AnalyticsResourceState<T> extends State<AnalyticsResource<T>>
    with WidgetsBindingObserver {
  T? _value;
  Object? _error;
  bool _loading = true;
  Timer? _timer;
  Timer? _clock;
  bool _foreground = true;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (_foreground &&
          !_loading &&
          (ModalRoute.of(context)?.isCurrent ?? true)) {
        _refresh();
      }
    });
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _value != null) setState(() {});
    });
  }

  @override
  void didUpdateWidget(covariant AnalyticsResource<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.key != widget.key) {
      _value = null;
      _error = null;
      _loading = true;
      _refresh();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground && (ModalRoute.of(context)?.isCurrent ?? true)) _refresh();
  }

  Future<void> _refresh() async {
    final generation = ++_generation;
    if (mounted) setState(() => _loading = true);
    try {
      final result = await widget.load();
      if (!mounted || generation != _generation) return;
      setState(() {
        _value = result;
        _error = null;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _clock?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final value = _value;
    if (value == null && _loading) return const AnalyticsSkeleton();
    if (value == null) {
      return AnalyticsState(
        message: 'Analytics unavailable',
        action: TextButton(onPressed: _refresh, child: const Text('Retry')),
      );
    }
    if (widget.isEmpty(value)) {
      return AnalyticsState(
        message: widget.emptyMessage,
        action: TextButton(onPressed: _refresh, child: const Text('Refresh')),
      );
    }
    final age = DateTime.now().toUtc().difference(widget.asOf(value));
    final stale = age > const Duration(seconds: 45) ||
        _error != null ||
        (widget.isStale?.call(value) ?? false);
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Row(
              children: [
                Icon(
                  stale ? Icons.warning_amber_rounded : Icons.circle,
                  size: stale ? 18 : 9,
                  color: stale ? EyelerColors.reduce : EyelerColors.defend,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    stale
                        ? 'Stale data · updated ${age.inSeconds < 0 ? 0 : age.inSeconds}s ago'
                        : 'Updated ${age.inSeconds < 0 ? 0 : age.inSeconds}s ago',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                if (_loading)
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                IconButton(
                  tooltip: 'Refresh analytics',
                  onPressed: _refresh,
                  icon: const Icon(Icons.refresh_outlined),
                ),
              ],
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                'Refresh failed. Showing last available data.',
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          widget.body(context, value, _refresh),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class AnalyticsSkeleton extends StatelessWidget {
  const AnalyticsSkeleton({super.key});
  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (final height in [74.0, 108.0, 108.0, 210.0, 160.0])
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Container(
                height: height,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surface,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Semantics(label: 'Loading analytics'),
              ),
            ),
        ],
      );
}

class AnalyticsState extends StatelessWidget {
  const AnalyticsState({super.key, required this.message, this.action});
  final String message;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.insights_outlined, size: 32),
              const SizedBox(height: 12),
              Text(message, textAlign: TextAlign.center),
              if (action != null) action!,
            ],
          ),
        ),
      );
}

class AnalyticsPanel extends StatelessWidget {
  const AnalyticsPanel({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
  });
  final String title;
  final Widget child;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  if (trailing != null) trailing!,
                ],
              ),
              const SizedBox(height: 14),
              child,
            ],
          ),
        ),
      );
}

class AnalyticsChart extends StatelessWidget {
  const AnalyticsChart({
    super.key,
    required this.points,
    this.color = EyelerColors.accent,
    this.height = 150,
  });
  final List<AnalyticsPoint> points;
  final Color color;
  final double height;
  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return const SizedBox(
        height: 100,
        child: Center(child: Text('No chart data')),
      );
    }
    return SizedBox(
      height: height,
      width: double.infinity,
      child: CustomPaint(
        painter: _LinePainter(points, color, Theme.of(context).dividerColor),
      ),
    );
  }
}

class _LinePainter extends CustomPainter {
  _LinePainter(this.points, this.color, this.grid);
  final List<AnalyticsPoint> points;
  final Color color, grid;

  @override
  void paint(Canvas canvas, Size size) {
    final values = points
        .where((e) => e.value != null)
        .map((e) => double.parse(e.value!))
        .toList();
    if (values.isEmpty) return;
    final minimum = values.reduce(math.min);
    final maximum = values.reduce(math.max);
    final span = maximum == minimum ? 1.0 : maximum - minimum;
    final baseline = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (var i = 1; i <= 3; i++) {
      final y = size.height * i / 4;
      canvas.drawLine(
        Offset.zero.translate(0, y),
        Offset(size.width, y),
        baseline,
      );
    }
    final path = Path();
    var plotted = 0;
    for (var i = 0; i < points.length; i++) {
      if (points[i].value == null) continue;
      final value = double.parse(points[i].value!);
      final x = points.length == 1 ? 0.0 : size.width * i / (points.length - 1);
      final y =
          size.height - 12 - (value - minimum) / span * (size.height - 24);
      if (plotted == 0 || points[i - 1].value == null) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
      plotted++;
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..strokeWidth = 2.5
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round,
    );
    if (plotted == 1) {
      final index = points.indexWhere((point) => point.value != null);
      final x =
          points.length == 1 ? 0.0 : size.width * index / (points.length - 1);
      canvas.drawCircle(Offset(x, size.height / 2), 4, Paint()..color = color);
    }
  }

  @override
  bool shouldRepaint(covariant _LinePainter old) =>
      old.points != points || old.color != color || old.grid != grid;
}

String analyticsLocalTime(DateTime value, BuildContext context) {
  final local = value.toLocal();
  final time = TimeOfDay.fromDateTime(local).format(context);
  return '${local.day}/${local.month} $time';
}

String shortAnalyticsAddress(String address) =>
    '${address.substring(0, 6)}…${address.substring(address.length - 4)}';

class AnalyticsMetricTile extends StatelessWidget {
  const AnalyticsMetricTile({
    super.key,
    required this.label,
    required this.value,
    this.delta,
    this.money = true,
  });
  final String label;
  final String? value;
  final String? delta;
  final bool money;
  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 8),
              Text(
                AnalyticsNumbers.compact(value, money: money),
                style: Theme.of(context).textTheme.headlineSmall,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              if (delta != null)
                Text(
                  '${delta!.startsWith('-') ? '' : '+'}$delta%',
                  style: TextStyle(
                    color: delta!.startsWith('-')
                        ? EyelerColors.exit
                        : EyelerColors.defend,
                  ),
                ),
            ],
          ),
        ),
      );
}
