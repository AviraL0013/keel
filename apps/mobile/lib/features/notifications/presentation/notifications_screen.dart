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
      appBar: AppBar(title: const Text('Notifications'), actions: [
        IconButton(
            onPressed: () => ref.invalidate(notificationProvider),
            icon: const Icon(Icons.refresh))
      ]),
      body: notifications.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ErrorStateCard(
            message: friendlyError(error),
            onRetry: () => ref.invalidate(notificationProvider)),
        data: (items) => items.isEmpty
            ? const EmptyStateCard(
                icon: Icons.notifications_none,
                title: 'ALL QUIET',
                message:
                    'Risk decisions, execution outcomes, and safety transitions will appear here.')
            : ListView.builder(
                padding: const EdgeInsets.fromLTRB(KeelSpacing.md,
                    KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl),
                itemCount: items.length + 1,
                itemBuilder: (_, index) => index == 0
                    ? const Padding(
                        padding: EdgeInsets.only(bottom: KeelSpacing.lg),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Updates', style: KeelTypography.display),
                            SizedBox(height: KeelSpacing.xs),
                            Text(
                                'Activity across your positions and protection.'),
                          ],
                        ),
                      )
                    : _NotificationTile(
                        item: items[index - 1],
                        onRead: () async {
                          await ref
                              .read(notificationRepositoryProvider)
                              .markRead(items[index - 1].id);
                          ref.invalidate(notificationProvider);
                        })),
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
    return KeelPanel(
        tone: visual.color,
        padding: EdgeInsets.zero,
        child: Material(
            color: Colors.transparent,
            child: InkWell(
                borderRadius: BorderRadius.circular(KeelRadii.card),
                onTap: item.unread ? onRead : null,
                child: Padding(
                    padding: const EdgeInsets.all(KeelSpacing.md),
                    child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          KeelIconTile(
                              icon: visual.icon, color: visual.color, size: 40),
                          const SizedBox(width: KeelSpacing.md),
                          Expanded(
                              child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                Row(
                                    mainAxisAlignment:
                                        MainAxisAlignment.spaceBetween,
                                    children: [
                                      Expanded(
                                          child: Text(item.title,
                                              style: KeelTypography.section)),
                                      if (item.unread)
                                        const StatusPill(
                                            label: 'UNREAD',
                                            color: KeelColors.accent)
                                    ]),
                                const SizedBox(height: KeelSpacing.xs),
                                Text(item.body,
                                    style: KeelTypography.body.copyWith(
                                        color: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.color)),
                                const SizedBox(height: KeelSpacing.sm),
                                Text(item.createdAt,
                                    style: KeelTypography.label.copyWith(
                                        color: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.color)),
                              ])),
                        ])))));
  }
}
