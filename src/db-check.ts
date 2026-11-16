import { openLibrary } from './library.js';

const library = await openLibrary();
const integrity = library.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
const migrations = library.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
const fts = library.db.prepare('SELECT count(*) AS n FROM knowledge_fts').get() as { n: number };
library.close();
if (integrity.some((row) => row.integrity_check !== 'ok')) {
  process.stderr.write('Database integrity check failed.\n');
  process.exit(1);
}
process.stdout.write(`SQLite integrity: ok\nMigrations: ${migrations.map((row) => row.version).join(', ') || 'none'}\nSearch index rows: ${fts.n}\n`);
