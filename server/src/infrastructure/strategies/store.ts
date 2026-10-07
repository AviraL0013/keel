import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import {
  initialState,
  strategyEquity,
  validateStrategyConfig,
  type StrategyConfig,
  type StrategyQuote,
  type StrategySide,
  type StrategyState,
} from '../../../../packages/strategies/src/index.js'

export type PaperFill = {
  id: string
  orderId: string
  side: StrategySide
  price: number
  size: number
  fee: number
  at: number
}

export type StrategyRecord = {
  id: string
  user_id: string
  connection_id: string
  environment: 'testnet' | 'mainnet'
  account_id: string
  market_id: number
  kind: StrategyConfig['kind']
  mode: StrategyConfig['mode']
  capital: string
  config: StrategyConfig
  state: StrategyState
  status: 'PAUSED' | 'RUNNING' | 'HALTED' | 'STOPPED'
  version: string
  live_confirmed_at: string | null
  created_at: string
  updated_at: string
}

export class StrategyStore {
  constructor(
    private readonly pool: Pool,
    private readonly environment: 'testnet' | 'mainnet',
  ) {}

  async create(userId: string, connectionId: string, input: StrategyConfig): Promise<StrategyRecord> {
    const config = validateStrategyConfig(input)
    const binding = await this.pool.query(
      `SELECT 1 FROM perpl_connections c JOIN perpl_accounts a ON a.connection_id=c.id
       JOIN perpl_account_owners o ON o.environment=c.environment AND o.account_id=a.account_id
       WHERE c.id=$1 AND c.user_id=$2 AND c.environment=$3 AND c.status='ACTIVE'
         AND c.revoked_at IS NULL AND c.expires_at>now() AND c.scope='trade'
         AND a.account_id=$4 AND a.forwarding=true AND a.frozen=false AND o.user_id=$2`,
      [connectionId, userId, this.environment, config.accountId],
    )
    if (!binding.rows.length) throw new Error('STRATEGY_CONNECTION_UNAVAILABLE')
    const inserted = await this.pool.query<StrategyRecord>(
      `INSERT INTO strategies(id,user_id,connection_id,environment,account_id,market_id,mode,kind,capital,config,state,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PAUSED') RETURNING *`,
      [
        randomUUID(),
        userId,
        connectionId,
        this.environment,
        config.accountId,
        config.marketId,
        config.mode,
        config.kind,
        config.capital,
        JSON.stringify(config),
        JSON.stringify(initialState(config)),
      ],
    )
    return inserted.rows[0]!
  }

  async get(userId: string, id: string): Promise<StrategyRecord | null> {
    const result = await this.pool.query<StrategyRecord>('SELECT * FROM strategies WHERE id=$1 AND user_id=$2', [
      id,
      userId,
    ])
    return result.rows[0] ?? null
  }

  async list(userId: string): Promise<StrategyRecord[]> {
    return (
      await this.pool.query<StrategyRecord>('SELECT * FROM strategies WHERE user_id=$1 ORDER BY created_at DESC', [
        userId,
      ])
    ).rows
  }

  async running(): Promise<StrategyRecord[]> {
    return (
      await this.pool.query<StrategyRecord>("SELECT * FROM strategies WHERE status='RUNNING' ORDER BY created_at,id")
    ).rows
  }

  async killed(userId: string): Promise<boolean> {
    const result = await this.pool.query<{ killed: boolean }>(
      'SELECT killed FROM strategy_user_controls WHERE user_id=$1',
      [userId],
    )
    return result.rows[0]?.killed ?? false
  }

  async kill(userId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO strategy_user_controls(user_id,killed) VALUES($1,true)
        ON CONFLICT(user_id) DO UPDATE SET killed=true,updated_at=now()`,
        [userId],
      )
      await client.query(
        `UPDATE strategies SET status='HALTED',
        state=jsonb_set(jsonb_set(state,'{openOrders}','[]'::jsonb),'{status}','"HALTED"'::jsonb),
        version=version+1,updated_at=now() WHERE user_id=$1 AND status='RUNNING'`,
        [userId],
      )
      await client.query(
        `UPDATE strategy_orders SET status='CANCELED',updated_at=now()
        WHERE strategy_id IN (SELECT id FROM strategies WHERE user_id=$1) AND simulated=true AND status IN ('OPEN','PARTIAL')`,
        [userId],
      )
      await client.query(
        `INSERT INTO strategy_risk_events(strategy_id,code)
        SELECT id,'KILL_SWITCH' FROM strategies WHERE user_id=$1 AND status='HALTED'`,
        [userId],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async resetKill(userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO strategy_user_controls(user_id,killed) VALUES($1,false)
      ON CONFLICT(user_id) DO UPDATE SET killed=false,updated_at=now()`,
      [userId],
    )
  }

  async pauseAll(userId: string): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const changed = await client.query(
        `UPDATE strategies SET status='PAUSED',
        state=jsonb_set(jsonb_set(state,'{openOrders}','[]'::jsonb),'{status}','"PAUSED"'::jsonb),
        version=version+1,updated_at=now()
        WHERE user_id=$1 AND mode='PAPER' AND status='RUNNING' RETURNING id`,
        [userId],
      )
      await client.query(
        `UPDATE strategy_orders SET status='CANCELED',updated_at=now()
        WHERE strategy_id IN (SELECT id FROM strategies WHERE user_id=$1 AND mode='PAPER')
          AND simulated=true AND status IN ('OPEN','PARTIAL')`,
        [userId],
      )
      await client.query('COMMIT')
      return changed.rows.length
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async resumeAll(userId: string): Promise<number> {
    if (await this.killed(userId)) throw new Error('STRATEGY_KILL_SWITCH')
    const changed = await this.pool.query(
      `UPDATE strategies SET status='RUNNING',
      state=jsonb_set(state,'{status}','"READY"'::jsonb),version=version+1,updated_at=now()
      WHERE user_id=$1 AND mode='PAPER' AND status='PAUSED' RETURNING id`,
      [userId],
    )
    return changed.rows.length
  }

  async configure(userId: string, id: string, input: StrategyConfig): Promise<StrategyRecord> {
    const config = validateStrategyConfig(input)
    const row = await this.get(userId, id)
    if (!row) throw new Error('STRATEGY_NOT_FOUND')
    if (
      row.status !== 'PAUSED' ||
      row.environment !== this.environment ||
      Number(row.account_id) !== config.accountId ||
      row.market_id !== config.marketId ||
      row.mode !== config.mode
    )
      throw new Error('STRATEGY_CONFIG_LOCKED')
    const changed = await this.pool.query<StrategyRecord>(
      `UPDATE strategies SET kind=$3,capital=$4,config=$5,state=$6,version=version+1,updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status='PAUSED' AND version=$7
         AND NOT EXISTS(SELECT 1 FROM strategy_fills WHERE strategy_id=$1) RETURNING *`,
      [
        id,
        userId,
        config.kind,
        config.capital,
        JSON.stringify(config),
        JSON.stringify(initialState(config)),
        row.version,
      ],
    )
    if (!changed.rows[0]) throw new Error('STRATEGY_CONFIG_LOCKED')
    return changed.rows[0]
  }

  async start(userId: string, id: string): Promise<StrategyRecord> {
    if (await this.killed(userId)) throw new Error('STRATEGY_KILL_SWITCH')
    const row = await this.get(userId, id)
    if (!row) throw new Error('STRATEGY_NOT_FOUND')
    if (row.mode === 'LIVE') throw new Error('STRATEGY_LIVE_WORKER_NOT_READY')
    if (row.mode === 'BACKTEST') throw new Error('STRATEGY_BACKTEST_RUN_REQUIRED')
    if (row.status !== 'PAUSED') throw new Error('STRATEGY_NOT_PAUSED')
    const result = await this.pool.query<StrategyRecord>(
      `UPDATE strategies SET status='RUNNING',state=jsonb_set(state,'{status}','"READY"'::jsonb),
       version=version+1,updated_at=now()
       WHERE id=$1 AND user_id=$2 AND status='PAUSED' RETURNING *`,
      [id, userId],
    )
    if (!result.rows[0]) throw new Error('STRATEGY_NOT_PAUSED')
    return result.rows[0]
  }

  async pause(userId: string, id: string): Promise<StrategyRecord> {
    return this.status(userId, id, 'PAUSED')
  }

  async stop(userId: string, id: string): Promise<StrategyRecord> {
    return this.status(userId, id, 'STOPPED')
  }

  private async status(userId: string, id: string, status: 'PAUSED' | 'STOPPED'): Promise<StrategyRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<StrategyRecord>(
        `UPDATE strategies SET status=$3,state=jsonb_set(jsonb_set(state,'{openOrders}','[]'::jsonb),'{status}','"PAUSED"'::jsonb),
         version=version+1,updated_at=now()
         WHERE id=$1 AND user_id=$2 AND status IN ('PAUSED','RUNNING','HALTED') RETURNING *`,
        [id, userId, status],
      )
      if (!result.rows[0]) throw new Error('STRATEGY_NOT_FOUND_OR_STOPPED')
      await client.query(
        `UPDATE strategy_orders SET status='CANCELED',updated_at=now()
        WHERE strategy_id=$1 AND simulated=true AND status IN ('OPEN','PARTIAL')`,
        [id],
      )
      await client.query('COMMIT')
      return result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async saveTick(row: StrategyRecord, state: StrategyState): Promise<boolean> {
    const equity = state.lastMark ? strategyEquity(state, state.lastMark) : state.capital
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `UPDATE strategies SET state=$3,status=$4,version=version+1,updated_at=now()
         WHERE id=$1 AND user_id=$2 AND version=$5 AND status='RUNNING' RETURNING id`,
        [row.id, row.user_id, JSON.stringify(state), state.status === 'HALTED' ? 'HALTED' : 'RUNNING', row.version],
      )
      if (!result.rows.length) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(
        `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
        VALUES($1,now(),$2,$3) ON CONFLICT(strategy_id,observed_at) DO NOTHING`,
        [row.id, equity, state.inventory],
      )
      for (const code of state.riskEvents.filter((value) => !row.state.riskEvents.includes(value)))
        await client.query('INSERT INTO strategy_risk_events(strategy_id,code) VALUES($1,$2)', [row.id, code])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async savePaperTick(
    row: StrategyRecord,
    state: StrategyState,
    canceledIds: string[],
    fills: PaperFill[],
    quotes: Array<StrategyQuote & { id: string }>,
    funding?: { at: number; amount: number },
  ): Promise<boolean> {
    const equity = state.lastMark ? strategyEquity(state, state.lastMark) : state.capital
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const updated = await client.query(
        `UPDATE strategies SET state=$3,status=$4,version=version+1,updated_at=now()
        WHERE id=$1 AND user_id=$2 AND version=$5 AND status='RUNNING' RETURNING id`,
        [row.id, row.user_id, JSON.stringify(state), state.status === 'HALTED' ? 'HALTED' : 'RUNNING', row.version],
      )
      if (!updated.rows.length) {
        await client.query('ROLLBACK')
        return false
      }
      for (const fill of fills) {
        await client.query(
          `UPDATE strategy_orders SET filled_size=filled_size+$2,
          status=CASE WHEN filled_size+$2>=size THEN 'FILLED' ELSE 'PARTIAL' END,updated_at=now()
          WHERE id=$1 AND strategy_id=$3 AND simulated=true`,
          [fill.orderId, fill.size, row.id],
        )
        await client.query(
          `INSERT INTO strategy_fills(id,strategy_id,order_id,side,liquidity,price,size,fee,filled_at,simulated)
          VALUES($1,$2,$3,$4,'MAKER',$5,$6,$7,to_timestamp($8/1000.0),true)`,
          [fill.id, row.id, fill.orderId, fill.side, fill.price, fill.size, fill.fee, fill.at],
        )
      }
      for (const id of canceledIds)
        await client.query(
          `UPDATE strategy_orders SET status='CANCELED',updated_at=now()
        WHERE id=$1 AND strategy_id=$2 AND simulated=true AND status IN ('OPEN','PARTIAL')`,
          [id, row.id],
        )
      for (const quote of quotes)
        await client.query(
          `INSERT INTO strategy_orders
        (id,strategy_id,environment,account_id,market_id,kind,simulated,status,side,price,size)
        VALUES($1,$2,$3,$4,$5,'POST',true,'OPEN',$6,$7,$8)`,
          [quote.id, row.id, row.environment, row.account_id, row.market_id, quote.side, quote.price, quote.size],
        )
      await client.query(
        `INSERT INTO strategy_equity_points(strategy_id,observed_at,equity,inventory)
        VALUES($1,to_timestamp($2/1000.0),$3,$4) ON CONFLICT(strategy_id,observed_at) DO UPDATE SET equity=EXCLUDED.equity,inventory=EXCLUDED.inventory`,
        [row.id, Date.now(), equity, state.inventory],
      )
      await client.query(
        `INSERT INTO strategy_tick_minutes(strategy_id,minute,first_tick,last_tick,tick_count)
        VALUES($1,date_trunc('minute',now()),now(),now(),1)
        ON CONFLICT(strategy_id,minute) DO UPDATE SET last_tick=EXCLUDED.last_tick,
          tick_count=strategy_tick_minutes.tick_count+1`,
        [row.id],
      )
      if (funding)
        await client.query(
          `INSERT INTO strategy_funding(strategy_id,applied_at,amount,simulated)
        VALUES($1,to_timestamp($2/1000.0),$3,true) ON CONFLICT(strategy_id,applied_at,simulated) DO NOTHING`,
          [row.id, funding.at, funding.amount],
        )
      for (const code of state.riskEvents.filter((value) => !row.state.riskEvents.includes(value)))
        await client.query('INSERT INTO strategy_risk_events(strategy_id,code) VALUES($1,$2)', [row.id, code])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async cancelPaperQuotes(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE strategy_orders SET status='CANCELED',updated_at=now()
        WHERE simulated=true AND status IN ('OPEN','PARTIAL') AND strategy_id IN
          (SELECT id FROM strategies WHERE environment=$1 AND mode='PAPER')`,
        [this.environment],
      )
      await client.query(
        `UPDATE strategies SET state=jsonb_set(state,'{openOrders}','[]'::jsonb),
        version=version+1,updated_at=now()
        WHERE environment=$1 AND mode='PAPER' AND status='RUNNING'`,
        [this.environment],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async orders(userId: string, id: string) {
    if (!(await this.get(userId, id))) throw new Error('STRATEGY_NOT_FOUND')
    return (await this.pool.query('SELECT * FROM strategy_orders WHERE strategy_id=$1 ORDER BY created_at DESC', [id]))
      .rows
  }
  async fills(userId: string, id: string) {
    if (!(await this.get(userId, id))) throw new Error('STRATEGY_NOT_FOUND')
    return (await this.pool.query('SELECT * FROM strategy_fills WHERE strategy_id=$1 ORDER BY filled_at DESC', [id]))
      .rows
  }
  async riskEvents(userId: string, id: string) {
    if (!(await this.get(userId, id))) throw new Error('STRATEGY_NOT_FOUND')
    return (
      await this.pool.query('SELECT * FROM strategy_risk_events WHERE strategy_id=$1 ORDER BY observed_at DESC', [id])
    ).rows
  }
}
