import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createPool } from '../src/db.js';

const defaultMigrationDirectory = resolve(process.cwd(), 'sql');

export async function migrate(pool: Pool, directory = defaultMigrationDirectory): Promise<void> {
  const files = (await readdir(directory))
    .filter((file) => /^[0-9]{3}_[a-z0-9_]+[.]sql$/.test(file))
    .sort();

  if (files.length === 0) throw new Error('No SQL migrations found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Prevent two application replicas from simultaneously applying migrations.
    await client.query('SELECT pg_advisory_xact_lock(91471283)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(128) PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const previous = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(previous.rows.map((row) => [row.version, row.checksum]));
    for (const version of applied.keys()) {
      if (!files.includes(version)) {
        throw new Error('An applied migration is missing from the source: ' + version);
      }
    }

    for (const filename of files) {
      const sql = await readFile(resolve(directory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const old = applied.get(filename);
      if (old !== undefined) {
        if (old !== checksum) {
          throw new Error('Applied migration has changed: ' + filename);
        }
        continue;
      }
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [filename, checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exitCode = 1;
  } else {
    const pool = createPool(url);
    migrate(pool)
      .then(() => console.log('Database migrations are up to date'))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : 'Migration failed');
        process.exitCode = 1;
      })
      .finally(() => pool.end());
  }
}
