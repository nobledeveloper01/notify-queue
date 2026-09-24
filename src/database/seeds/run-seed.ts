import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { configuration } from '../../config/configuration.js';

/**
 * Applies seed.sql (or the file given as the first argument) to the
 * configured database, then prints the job counts by status.
 * Run after migrations: `npm run seed`, or the `seed` compose profile.
 */
const run = async (): Promise<void> => {
  const file = resolve(process.argv[2] ?? 'seed.sql');
  const sql = await readFile(file, 'utf8');
  const { database } = configuration();

  const client = new pg.Client({
    host: database.host,
    port: database.port,
    database: database.name,
    user: database.user,
    password: database.password,
  });
  await client.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query<{ status: string; count: string }>(
      'SELECT status, count(*) FROM notification_jobs GROUP BY status ORDER BY status',
    );
    process.stdout.write(`Seeded ${file}\n`);
    for (const { status, count } of rows) {
      process.stdout.write(`  ${status.padEnd(14)} ${count}\n`);
    }
  } finally {
    await client.end();
  }
};

await run();
