import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { DbPool } from './db/pool.js';
import type { Config } from './config.js';

export async function buildServer(pool: DbPool, config: Config) {
  const server = Fastify({
    logger: true,
  });

  await server.register(sensible);

  server.get('/health', async () => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', db: 'connected' };
    } catch {
      throw server.httpErrors.serviceUnavailable('Database connection failed');
    }
  });

  return server;
}
