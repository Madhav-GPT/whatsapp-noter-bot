import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DATA_DIR, SETTINGS_PATH, TELEGRAM_OFFSET_PATH, TELEGRAM_OWNER_PATH, TELEGRAM_STATE_PATH, TELEGRAM_TOKEN_PATH } from '../paths.js';

export type TelegramOwner = { chatId: number; userId: number; pairedAt: string };
export type TelegramWorkerState = { connected: boolean; botUsername?: string; lastPollAt?: string; lastError?: string };

export async function readTelegramToken(): Promise<string> {
  const token = (await readFile(TELEGRAM_TOKEN_PATH, 'utf8')).trim();
  if (!token || token.length > 512 || /\s/.test(token)) throw new Error('Telegram bot token is missing or invalid. Run `npm run telegram:configure`.');
  return token;
}

export async function readTelegramOwner(): Promise<TelegramOwner | null> {
  try {
    const value = JSON.parse(await readFile(TELEGRAM_OWNER_PATH, 'utf8')) as Partial<TelegramOwner>;
    if (!Number.isSafeInteger(value.chatId) || Number(value.chatId) <= 0 || !Number.isSafeInteger(value.userId) || Number(value.userId) <= 0 || !value.pairedAt) return null;
    return { chatId: value.chatId!, userId: value.userId!, pairedAt: value.pairedAt };
  } catch {
    return null;
  }
}

export async function readTelegramOffset(): Promise<number | undefined> {
  try {
    const value = Number((await readFile(TELEGRAM_OFFSET_PATH, 'utf8')).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeTelegramOffset(value: number): Promise<void> {
  await writePrivateFile(TELEGRAM_OFFSET_PATH, `${value}\n`);
}

export async function writeTelegramOwner(owner: TelegramOwner): Promise<void> {
  await writePrivateFile(TELEGRAM_OWNER_PATH, `${JSON.stringify(owner, null, 2)}\n`);
}

export async function writeTelegramState(state: TelegramWorkerState): Promise<void> {
  await writePrivateFile(TELEGRAM_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export async function activateTelegramTransport(): Promise<void> {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
  } catch {
    // First-run configuration.
  }
  await writePrivateFile(SETTINGS_PATH, `${JSON.stringify({ ...settings, transport: 'telegram' }, null, 2)}\n`);
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}
