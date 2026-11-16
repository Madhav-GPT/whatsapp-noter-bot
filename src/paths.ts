import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export const DATA_DIR = process.env.REEL_TO_CODEX_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'ReelToCodex');
export const DATABASE_PATH = process.env.REEL_TO_CODEX_DATABASE ?? join(DATA_DIR, 'knowledge.sqlite');
export const TOKEN_PATH = join(DATA_DIR, 'collector-token');
export const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const EXTENSION_ID = 'bigaphijjgaoaddakapcaebjfgbfmcnd';

function loadSelfChatTitle(): string {
  const override = process.env.REEL_TO_CODEX_SELF_CHAT_TITLE;
  if (override?.trim().endsWith(' (You)')) return override.trim();
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as { selfChatTitle?: unknown };
    if (typeof settings.selfChatTitle === 'string' && settings.selfChatTitle.trim().endsWith(' (You)')) return settings.selfChatTitle.trim();
  } catch {
    // Setup has not run yet; use a generic placeholder until a title is configured locally.
  }
  return 'Message Yourself (You)';
}

export const SELF_CHAT_TITLE = loadSelfChatTitle();
