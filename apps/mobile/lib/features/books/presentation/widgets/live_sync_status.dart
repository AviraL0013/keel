import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/theme/app_theme.dart';

/// A fixed-height status slot; refreshing never replaces loaded content.
class LiveSyncStatus extends StatefulWidget {
  const LiveSyncStatus({super.key, required this.value});
  final AsyncValue<Object?> value;

  @override
  State<LiveSyncStatus> createState() => _LiveSyncStatusState();
}

class _LiveSyncStatusState extends State<LiveSyncStatus> {
  Timer? _timer;
  bool _updated = false;

  @override
  void didUpdateWidget(covariant LiveSyncStatus oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value.isLoading) {
      _timer?.cancel();
      _updated = false;
    } else if (!widget.value.hasError && widget.value.hasValue && oldWidget.value.hasValue && oldWidget.value.value != widget.value.value) {
      _updated = true;
      _timer?.cancel();
      _timer = Timer(const Duration(seconds: 2), () {
        if (mounted) setState(() => _updated = false);
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
      height: 24,
      child: Align(
          alignment: Alignment.centerRight,
          child: Text(
              widget.value.isLoading ? 'SYNCING' : widget.value.hasError ? 'CONNECTION LOST · RETRYING' : _updated ? 'UPDATED' : '',
              style: KeelTypography.label)));
}
