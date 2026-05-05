import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  await migrate(pool, migrationsDir);

  const server = await buildServer(pool, config);

  await server.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
