import pg from 'pg';

const { Pool } = pg;

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(connectionString: string): DbPool {
  return new Pool({ connectionString });
}

export async function query<T extends pg.QueryResultRow>(
  pool: DbPool,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params);
}
