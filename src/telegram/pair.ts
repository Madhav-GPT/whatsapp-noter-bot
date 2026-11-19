import { randomBytes } from 'node:crypto';
import { TelegramApi, TelegramApiError, type TelegramUpdate } from './api.js';
import { readTelegramOffset, readTelegramOwner, readTelegramToken, writeTelegramOffset, writeTelegramOwner, activateTelegramTransport } from './local-state.js';
import { isPairingCommand } from './updates.js';
import { openLibrary } from '../library.js';

const PAIRING_WINDOW_MS = 10 * 60 * 1000;
let stopping = false;

function isPrivatePairingMessage(update: TelegramUpdate, code: string): { chatId: number; userId: number } | null {
  const message = update.message;
  const sender = message?.from;
  if (!message || message.chat.type !== 'private' || !sender || sender.is_bot || message.chat.id !== sender.id) return null;
  if (!isPairingCommand(message.text, code)) return null;
  return { chatId: message.chat.id, userId: sender.id };
}

async function run(): Promise<void> {
  if (await readTelegramOwner()) throw new Error('This Telegram bot is already paired. Contact the project owner to reset pairing.');
  const api = new TelegramApi(await readTelegramToken());
  const bot = await api.getMe();
  const code = randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + PAIRING_WINDOW_MS;
  let offset = await readTelegramOffset();

  process.stdout.write(`Pairing @${bot.username ?? 'your bot'} with this local gateway.\n`);
  process.stdout.write(`Open the bot's private chat, tap Start if shown, then send /pair ${code}\n`);
  process.stdout.write('This code expires in 10 minutes. Other chats and messages will be ignored. Press Ctrl+C to cancel.\n');

  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  while (!stopping && Date.now() < expiresAt) {
    let updates: TelegramUpdate[];
    try {
      updates = await api.getUpdates(offset, 20);
    } catch (error) {
      if (stopping) break;
      if (error instanceof TelegramApiError && [401, 409].includes(error.errorCode ?? 0)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }

    for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
      const nextOffset = update.update_id + 1;
      const match = isPrivatePairingMessage(update, code);
      if (match) {
        // Consume the pairing command before storing the owner, so a crash cannot
        // replay /pair as an ordinary request after the service starts.
        await writeTelegramOffset(nextOffset);
        const library = await openLibrary();
        try {
          library.setAgentChatMode(true);
        } finally {
          library.close();
        }
        await writeTelegramOwner({ ...match, pairedAt: new Date().toISOString() });
        await activateTelegramTransport();
        await api.sendMessage(match.chatId, 'Telegram gateway connected. Send /help to see the available commands.');
        process.stdout.write('Private Telegram chat paired. Only this account will be accepted.\n');
        return;
      }
      await writeTelegramOffset(nextOffset);
      offset = nextOffset;
    }
  }
  if (stopping) process.stdout.write('Telegram pairing cancelled.\n');
  else throw new Error('Pairing code expired. Run `npm run telegram:pair` to generate a new one.');
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Telegram pairing failed.'}\n`);
  process.exitCode = 1;
}
