import pg from 'pg'
export type StoredNotification = { id: string; kind: string; title: string; body: string; readAt?: string; createdAt: string }
export class NotificationStore { constructor(private readonly pool: pg.Pool) {}
  async list(userId: string): Promise<StoredNotification[]> { const result = await this.pool.query('SELECT id,kind,title,body,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[userId]); return result.rows.map(row => ({ id: String(row.id), kind: String(row.kind), title: String(row.title), body: String(row.body), readAt: row.read_at ? new Date(String(row.read_at)).toISOString() : undefined, createdAt: new Date(String(row.created_at)).toISOString() })) }
  async markRead(userId: string, id: string) { await this.pool.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE user_id=$1 AND id=$2',[userId,id]) }
  async create(userId: string, kind: string, title: string, body: string, dedupeKey: string) { await this.pool.query('INSERT INTO notifications(user_id,kind,title,body,dedupe_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe_key) DO NOTHING',[userId,kind,title,body,dedupeKey]) }
}

