export interface TransactionClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>
}

/** Caller owns BEGIN/COMMIT. Repeated confirmation cannot deploy twice. */
export async function settleDefense(client: TransactionClient, bookId: string, amount: number, actionId: string, decisionId: string) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_DEPLOYMENT_AMOUNT')
  const action = await client.query('SELECT * FROM actions WHERE id=$1 AND book_id=$2 AND decision_id=$3 FOR UPDATE', [actionId, bookId, decisionId])
  if (action.rows.length !== 1 || action.rows[0].kind !== 'DEFEND' || action.rows[0].status !== 'CONFIRMED' || Number(action.rows[0].amount) !== amount) throw new Error('UNCONFIRMED_DEPLOYMENT')
  const existing = await client.query("SELECT id FROM reserve_ledger_entries WHERE action_id=$1 AND type='RESERVE_DEPLOYED'", [actionId])
  if (existing.rows.length) return
  const result = await client.query(`UPDATE reserves r SET available=r.available-$1,deployed=r.deployed+$1,updated_at=now()
    FROM books b WHERE r.book_id=$2 AND b.id=r.book_id AND r.deployed+r.reserved+$1<=LEAST(r.cap,b.defense_cap) AND r.available >= $1 RETURNING r.book_id`, [amount, bookId])
  if (result.rows.length !== 1) throw new Error('RESERVE_INVARIANT_VIOLATION')
  await client.query(`INSERT INTO reserve_ledger_entries(book_id,type,amount,action_id,decision_id,external_reference)
    VALUES($1,'RESERVE_DEPLOYED',$2,$3,$4,$5)`, [bookId, amount, actionId, decisionId, action.rows[0].venue_reference ?? null])
  await client.query("INSERT INTO autopsy_events(book_id,type,payload) VALUES($1,'RESERVE_DEPLOYED',$2)", [bookId, JSON.stringify({ amount, actionId, decisionId })])
}
