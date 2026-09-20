class NotificationItem {
  const NotificationItem(
      {required this.id,
      required this.title,
      required this.body,
      required this.kind,
      required this.createdAt,
      this.readAt});
  final String id, title, body, kind, createdAt;
  final String? readAt;
  bool get unread => readAt == null;
  factory NotificationItem.fromJson(Map<String, dynamic> json) =>
      NotificationItem(
          id: json['id'] as String? ?? '',
          title: json['title'] as String? ?? 'Notification',
          body: json['body'] as String? ?? '',
          kind: json['kind'] as String? ?? 'INFO',
          createdAt: json['createdAt'] as String? ?? '',
          readAt: json['readAt'] as String?);
}
