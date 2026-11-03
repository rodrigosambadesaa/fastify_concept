import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from '../scripts/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool);
    const app = await buildApp({
      pool,
      apiKey: config.apiKey,
      enableDocs: config.enableDocs,
      logLevel: config.logLevel,
    });

    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try {
        await app.close();
      } finally {
        await pool.end();
      }
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch((error: unknown) => {
  // Do not log a connection string or environment variables.
  console.error(error instanceof Error ? error.message : 'Unable to start server');
  process.exitCode = 1;
});
