import 'package:flutter/material.dart';
import '../../../../core/theme/app_theme.dart';
import '../../domain/book.dart';

/// Consumer-facing copy only. Backend risk and execution states stay authoritative.
class BookSummary {
  const BookSummary(this.label, this.message, this.color, this.icon);
  final String label;
  final String message;
  final Color color;
  final IconData icon;

  static BookSummary from(Book book, BookTelemetry state) {
    final execution = state.executionState;
    if (execution == 'UNKNOWN') {
      return const BookSummary(
          'Checking with Perpl',
          'The last action has no confirmed result yet. KEEL is still checking and will not repeat it.',
          KeelColors.reduce,
          Icons.hourglass_top_outlined);
    }
    if (const {
      'QUEUED',
      'VALIDATING',
      'SUBMITTING',
      'SUBMITTED',
      'VERIFYING',
      'ACCEPTED',
      'OPEN',
      'PARTIALLY_FILLED'
    }.contains(execution)) {
      return const BookSummary(
          'Action in progress',
          'KEEL is checking the result with Perpl. Do not repeat this action.',
          KeelColors.reduce,
          Icons.hourglass_top_outlined);
    }
    if (execution == 'PARTIAL') {
      return const BookSummary(
          'Action needs review',
          'Part of the action completed. KEEL paused further actions while checking the position.',
          KeelColors.reduce,
          Icons.hourglass_top_outlined);
    }
    if (book.status == 'CLOSED') {
      return const BookSummary(
          'Book closed',
          'This Book is complete. Its activity remains available here.',
          KeelColors.hold,
          Icons.check_circle_outline);
    }
    if (const {'FAILED', 'CANCELED', 'EXPIRED'}.contains(execution)) {
      return const BookSummary(
          'Action not completed',
          'The last action did not complete. Open this Book before trying again.',
          KeelColors.exit,
          Icons.error_outline);
    }
    if (book.status == 'SAFE_MODE' || state.riskState == 'SAFE_MODE') {
      return const BookSummary(
          'Needs attention',
          'KEEL paused actions for safety. Open this Book to see why.',
          KeelColors.safeMode,
          Icons.warning_amber_outlined);
    }
    if (book.status == 'PAUSED') {
      return const BookSummary(
          'Paused',
          'This Book is paused. Automatic actions are off.',
          KeelColors.reduce,
          Icons.pause_circle_outline);
    }
    if (state.stale ||
        state.freshnessUnknown ||
        state.riskState == null ||
        state.riskState == 'UNKNOWN') {
      return const BookSummary(
          'Checking status',
          'Live information is incomplete. Open this Book for details.',
          KeelColors.reduce,
          Icons.help_outline);
    }
    if (const {'DEFEND', 'REDUCE', 'EXIT'}.contains(state.riskState)) {
      return const BookSummary(
          'Review position',
          'KEEL has flagged this position for review.',
          KeelColors.reduce,
          Icons.priority_high);
    }
    return const BookSummary('Watching', 'KEEL is monitoring this position.',
        KeelColors.defend, Icons.visibility_outlined);
  }
}
