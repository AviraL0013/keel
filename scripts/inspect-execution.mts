import pg from 'pg'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  await pool.query('BEGIN READ ONLY')
  const actions = await pool.query(`SELECT a.id,a.book_id,a.decision_id,a.kind,a.amount,a.status,a.venue_reference,a.submitted_at,a.confirmed_at,a.failed_at,a.error,a.idempotency_key,b.venue_account_id,b.venue_position_id,b.market_id,b.status AS book_status,b.automation_enabled,d.state AS decision_state,d.reason_codes,d.human_readable_reasons,d.created_at AS decision_at FROM actions a JOIN books b ON b.id=a.book_id LEFT JOIN decisions d ON d.id=a.decision_id WHERE b.venue_account_id=642 ORDER BY d.created_at DESC LIMIT 5`)
  console.log(JSON.stringify({ actions: actions.rows }, null, 2))
  for (const action of actions.rows) {
    const events = await pool.query('SELECT type,payload,timestamp FROM autopsy_events WHERE book_id=$1 ORDER BY timestamp DESC LIMIT 20', [action.book_id])
    console.log(JSON.stringify({ bookId: action.book_id, events: events.rows }, null, 2))
  }
  await pool.query('ROLLBACK')
} finally { await pool.end() }
