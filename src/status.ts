import { openLibrary } from './library.js';
import { ACTIVE_TRANSPORT, TELEGRAM_STATE_PATH } from './paths.js';
import { readFile } from 'node:fs/promises';

const library = await openLibrary();
const status = library.getCollectorStatus();
const counts = {
  items: (library.db.prepare('SELECT count(*) AS n FROM source_items').get() as { n: number }).n,
  pending: (library.db.prepare("SELECT count(*) AS n FROM source_items WHERE status='pending'").get() as { n: number }).n,
  instructions: (library.db.prepare('SELECT count(*) AS n FROM instructions').get() as { n: number }).n,
};
let transportConnected = false;
let endpoint = 'offline';
if (ACTIVE_TRANSPORT === 'telegram') {
  try {
    const telegram = JSON.parse(await readFile(TELEGRAM_STATE_PATH, 'utf8')) as { connected?: boolean; lastPollAt?: string };
    transportConnected = telegram.connected === true && Boolean(telegram.lastPollAt) && Date.now() - Date.parse(telegram.lastPollAt!) < 60_000;
    if (transportConnected) endpoint = 'Telegram Bot API long polling';
  } catch {
    // Status stays offline until the Telegram worker records a successful poll.
  }
} else {
  try {
    const response = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(1500) });
    if (response.ok) endpoint = 'listening on loopback';
  } catch {
    // The status command reports a stopped collector without printing request details.
  }
  transportConnected = status.collectorRunning;
}
process.stdout.write(`${JSON.stringify({
  ...status,
  collectorRunning: ACTIVE_TRANSPORT === 'telegram' ? transportConnected : status.collectorRunning,
  transport: ACTIVE_TRANSPORT,
  transportConnected,
  endpoint,
  counts,
}, null, 2)}\n`);
library.close();
