import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/errors/eyeler_exception.dart';
import '../../../core/theme/app_theme.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
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
                padding: const EdgeInsets.fromLTRB(EyelerSpacing.md,
                    EyelerSpacing.sm, EyelerSpacing.md, EyelerSpacing.xl),
                itemCount: items.length + 1,
                itemBuilder: (_, index) => index == 0
                    ? const Padding(
                        padding: EdgeInsets.only(bottom: EyelerSpacing.lg),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Updates', style: EyelerTypography.display),
                            SizedBox(height: EyelerSpacing.xs),
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
    final visual = EyelerRiskVisual.forState(item.kind);
    return EyelerPanel(
        tone: visual.color,
        padding: EdgeInsets.zero,
        child: Material(
            color: Colors.transparent,
            child: InkWell(
                borderRadius: BorderRadius.circular(EyelerRadii.card),
                onTap: item.unread ? onRead : null,
                child: Padding(
                    padding: const EdgeInsets.all(EyelerSpacing.md),
                    child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          EyelerIconTile(
                              icon: visual.icon, color: visual.color, size: 40),
                          const SizedBox(width: EyelerSpacing.md),
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
                                              style: EyelerTypography.section)),
                                      if (item.unread)
                                        const StatusPill(
                                            label: 'UNREAD',
                                            color: EyelerColors.accent)
                                    ]),
                                const SizedBox(height: EyelerSpacing.xs),
                                Text(item.body,
                                    style: EyelerTypography.body.copyWith(
                                        color: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.color)),
                                const SizedBox(height: EyelerSpacing.sm),
                                Text(item.createdAt,
                                    style: EyelerTypography.label.copyWith(
                                        color: Theme.of(context)
                                            .textTheme
                                            .bodyMedium
                                            ?.color)),
                              ])),
                        ])))));
  }
}
