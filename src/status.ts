import { openLibrary } from './library.js';

const library = await openLibrary();
const status = library.getCollectorStatus();
const counts = {
  items: (library.db.prepare('SELECT count(*) AS n FROM source_items').get() as { n: number }).n,
  pending: (library.db.prepare("SELECT count(*) AS n FROM source_items WHERE status='pending'").get() as { n: number }).n,
  instructions: (library.db.prepare('SELECT count(*) AS n FROM instructions').get() as { n: number }).n,
};
let endpoint = 'offline';
try {
  const response = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(1500) });
  if (response.ok) endpoint = 'listening on loopback';
} catch {
  // The status command reports a stopped collector without printing request details.
}
process.stdout.write(`${JSON.stringify({ ...status, endpoint, counts }, null, 2)}\n`);
library.close();
