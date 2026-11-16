import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, SETTINGS_PATH, TOKEN_PATH, SELF_CHAT_TITLE } from './paths.js';

await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
await chmod(DATA_DIR, 0o700);

const titleFlag = process.argv.indexOf('--self-chat-title');
const selfChatTitle = (titleFlag >= 0 ? process.argv[titleFlag + 1] : process.env.REEL_TO_CODEX_SELF_CHAT_TITLE)?.trim() || SELF_CHAT_TITLE;
if (!selfChatTitle.endsWith(' (You)') || selfChatTitle.length > 120) {
  process.stderr.write('Self-chat title must end with "(You)" and be at most 120 characters.\n');
  process.exit(1);
}

let token: string;
try {
  token = (await readFile(TOKEN_PATH, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error('invalid token');
} catch {
  token = randomBytes(32).toString('base64url');
  await writeFile(TOKEN_PATH, `${token}\n`, { mode: 0o600, flag: 'wx' }).catch(async () => {
    await writeFile(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  });
}
await chmod(TOKEN_PATH, 0o600);
const extensionConfig = fileURLToPath(new URL('../extension/config.js', import.meta.url));
const extensionTitle = JSON.stringify(selfChatTitle);
await writeFile(SETTINGS_PATH, `${JSON.stringify({ selfChatTitle }, null, 2)}\n`, { mode: 0o600 });
await chmod(SETTINGS_PATH, 0o600);
await writeFile(extensionConfig, `globalThis.REEL_TO_CODEX_TOKEN = ${JSON.stringify(token)};\nglobalThis.REEL_TO_CODEX_SELF_CHAT_TITLE = ${extensionTitle};\n`, { mode: 0o600 });
await chmod(extensionConfig, 0o600);
process.stdout.write('Local collector token and extension configuration are ready.\n');
