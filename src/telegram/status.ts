import { stat, readFile } from 'node:fs/promises';
import { TELEGRAM_OWNER_PATH, TELEGRAM_STATE_PATH, TELEGRAM_TOKEN_PATH } from '../paths.js';
import { readTelegramOwner } from './local-state.js';

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

const [tokenConfigured, owner] = await Promise.all([exists(TELEGRAM_TOKEN_PATH), readTelegramOwner()]);
let worker: Record<string, unknown> | null = null;
if (await exists(TELEGRAM_STATE_PATH)) {
  try { worker = JSON.parse(await readFile(TELEGRAM_STATE_PATH, 'utf8')) as Record<string, unknown>; } catch { worker = { state: 'invalid' }; }
}
process.stdout.write(`${JSON.stringify({ tokenConfigured, paired: owner !== null, worker }, null, 2)}\n`);
