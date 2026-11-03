import { Pool, type PoolClient } from 'pg';

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    application_name: 'fastify-concept-api',
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

/** All business writes and their corresponding audit events commit atomically. */
export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure; the pool discards broken connections.
    }
    throw error;
  } finally {
    client.release();
  }
}
