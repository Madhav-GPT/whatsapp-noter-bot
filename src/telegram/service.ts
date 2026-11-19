import { createHash } from 'node:crypto';
import { openLibrary } from '../library.js';
import { TELEGRAM_CHAT_TITLE } from '../paths.js';
import { TelegramApi, TelegramApiError, TelegramNetworkError, type TelegramUpdate } from './api.js';
import { readTelegramOffset, readTelegramOwner, readTelegramToken, writeTelegramOffset, writeTelegramState } from './local-state.js';
import { messageText, ownerPrivateMessage, telegramMessageKey, telegramUpdateTime } from './updates.js';

const library = await openLibrary();
const loadedOwner = await readTelegramOwner();
if (!loadedOwner) {
  library.close();
  throw new Error('Telegram has no paired private chat. Run `npm run telegram:pair` first.');
}
const owner = loadedOwner;

const api = new TelegramApi(await readTelegramToken());
let offset = await readTelegramOffset();
let stopping = false;
let sending = false;
let botUsername: string | undefined;

function log(message: string): void {
  process.stderr.write(`[telegram] ${message}\n`);
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const message = ownerPrivateMessage(update, owner);
  if (message) {
    const text = messageText(message);
    if (text && text.length <= 10_000) {
      library.ingest({
        chatTitle: TELEGRAM_CHAT_TITLE,
        transport: 'telegram',
        messageKey: telegramMessageKey(message.chat.id, message.message_id),
        text,
        observedAt: telegramUpdateTime(message.date),
      });
    } else if (text) {
      log('ignored an owner message above the 10,000-character limit');
    }
  }

  offset = update.update_id + 1;
  await writeTelegramOffset(offset);
}

async function sendOneOutbound(): Promise<void> {
  if (sending || stopping) return;
  sending = true;
  try {
    const item = library.claimNextOutbound(TELEGRAM_CHAT_TITLE, 'telegram');
    if (!item) return;
    try {
      const sent = await api.sendMessage(owner.chatId, item.body);
      const key = createHash('sha256').update(`telegram:${owner.chatId}:${sent.message_id}`).digest('base64url');
      library.markOutboundSent(item.id, key);
    } catch (error) {
      if (error instanceof TelegramApiError) library.markOutboundFailed(item.id);
      else library.markOutboundUncertain(item.id);
      log(error instanceof Error ? error.message : 'outbound send failed');
    }
  } finally {
    sending = false;
  }
}

const sendTimer = setInterval(() => { void sendOneOutbound(); }, 1_000);

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(sendTimer);
  await writeTelegramState({ connected: false, ...(botUsername ? { botUsername } : {}), lastPollAt: new Date().toISOString() }).catch(() => undefined);
  library.close();
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

try {
  const me = await api.getMe();
  if (!me.is_bot) throw new Error('Configured Telegram identity is not a bot.');
  botUsername = me.username;
  log(`connected as @${botUsername ?? 'configured bot'}; private owner chat only`);
  await writeTelegramState({ connected: true, ...(botUsername ? { botUsername } : {}), lastPollAt: new Date().toISOString() });

  while (!stopping) {
    try {
      const updates = await api.getUpdates(offset, 25);
      for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
        if (stopping) break;
        await processUpdate(update);
      }
      await writeTelegramState({ connected: true, ...(botUsername ? { botUsername } : {}), lastPollAt: new Date().toISOString() });
    } catch (error) {
      if (stopping) break;
      if (error instanceof TelegramApiError && [401, 409].includes(error.errorCode ?? 0)) throw error;
      const message = error instanceof TelegramApiError || error instanceof TelegramNetworkError ? error.message : 'poll or message processing failed';
      await writeTelegramState({ connected: false, ...(botUsername ? { botUsername } : {}), lastPollAt: new Date().toISOString(), lastError: message.slice(0, 240) }).catch(() => undefined);
      log(`${message}; retrying in 3 seconds`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
} catch (error) {
  await shutdown();
  log(error instanceof Error ? error.message : 'failed to start Telegram transport');
  process.exitCode = 1;
}
