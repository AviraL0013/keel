import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../data/notification_repository.dart';
import '../domain/notification_item.dart';

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifications = ref.watch(notificationProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('NOTIFICATIONS'), actions: [IconButton(onPressed: () => ref.invalidate(notificationProvider), icon: const Icon(Icons.refresh))]),
      body: notifications.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(message: friendlyError(error), onRetry: () => ref.invalidate(notificationProvider)),
        data: (items) => items.isEmpty
            ? const EmptyStateCard(icon: Icons.notifications_none, title: 'ALL QUIET', message: 'Risk decisions, execution outcomes, and safety transitions will appear here.')
            : ListView.builder(padding: const EdgeInsets.fromLTRB(KeelSpacing.md, KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl), itemCount: items.length, itemBuilder: (_, index) => _NotificationTile(item: items[index], onRead: () async { await ref.read(notificationRepositoryProvider).markRead(items[index].id); ref.invalidate(notificationProvider); })),
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.item, required this.onRead});
  final NotificationItem item;
  final VoidCallback onRead;

  @override
  Widget build(BuildContext context) {
    final visual = KeelRiskVisual.forState(item.kind);
    return Card(margin: const EdgeInsets.only(bottom: KeelSpacing.md), child: InkWell(borderRadius: BorderRadius.circular(KeelRadii.card), onTap: item.unread ? onRead : null, child: Padding(padding: const EdgeInsets.all(KeelSpacing.md), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Container(width: 38, height: 38, decoration: BoxDecoration(color: visual.color.withValues(alpha: .18), shape: BoxShape.circle), child: Icon(visual.icon, color: visual.color, size: 19)),
      const SizedBox(width: KeelSpacing.md),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Expanded(child: Text(item.title, style: KeelTypography.section)), if (item.unread) const StatusPill(label: 'UNREAD', color: KeelColors.accent)]),
        const SizedBox(height: KeelSpacing.xs),
        Text(item.body, style: KeelTypography.body.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)),
        const SizedBox(height: KeelSpacing.sm),
        Text(item.createdAt, style: KeelTypography.label.copyWith(color: Theme.of(context).textTheme.bodyMedium?.color)),
      ])),
    ]))));
  }
}
