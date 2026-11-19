import { TelegramApi } from './api.js';
import { TELEGRAM_TOKEN_PATH } from '../paths.js';
import { writePrivateFile } from './local-state.js';

async function readHiddenToken(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run `npm run telegram:configure` in a terminal so the token can be entered without echoing it.');
  }

  process.stdout.write('Paste the BotFather token (input hidden): ');
  input.setRawMode(true);
  input.resume();
  let value = '';
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (buffer: Buffer) => {
        const chunk = buffer.toString('utf8').replace(/\u001b\[200~|\u001b\[201~/g, '');
        for (const character of chunk) {
          if (character === '\u0003') {
            cleanup();
            reject(new Error('Token setup cancelled.'));
            return;
          }
          if (character === '\r' || character === '\n') {
            cleanup();
            process.stdout.write('\n');
            resolve(value.trim());
            return;
          }
          if (character === '\u007f' || character === '\b') {
            value = value.slice(0, -1);
          } else if (character >= ' ' && character <= '~') {
            value += character;
          }
        }
      };
      const cleanup = () => input.off('data', onData);
      input.on('data', onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
  }
}

try {
  const token = await readHiddenToken();
  if (!token || token.length > 512 || /\s/.test(token)) throw new Error('Token format is invalid. Check the value copied from BotFather.');
  const bot = await new TelegramApi(token).getMe();
  if (!bot.is_bot || !bot.id) throw new Error('Telegram did not identify this token as a bot token.');
  const webhook = await new TelegramApi(token).getWebhookInfo();
  if (webhook.url) throw new Error('This bot already has a webhook configured. Use a new bot for this local long-polling gateway.');
  await writePrivateFile(TELEGRAM_TOKEN_PATH, `${token}\n`);
  process.stdout.write(`Bot token verified for @${bot.username ?? 'unnamed-bot'} and stored in the owner-only application data folder.\n`);
  process.stdout.write('Next: run `npm run telegram:pair` and send its one-time pairing code to the bot in a private chat.\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Telegram token setup failed.'}\n`);
  process.exitCode = 1;
}
