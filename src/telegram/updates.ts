import { createHash } from 'node:crypto';
import type { TelegramMessage, TelegramUpdate } from './api.js';
import type { TelegramOwner } from './local-state.js';

export function ownerPrivateMessage(update: TelegramUpdate, owner: TelegramOwner): TelegramMessage | null {
  const message = update.message;
  if (!message || message.chat.type !== 'private' || message.chat.id !== owner.chatId) return null;
  if (!message.from || message.from.is_bot || message.from.id !== owner.userId) return null;
  return message;
}

export function messageText(message: TelegramMessage): string | undefined {
  if (typeof message.text === 'string') return message.text;
  if (typeof message.caption === 'string') return message.caption;
  return undefined;
}

export function telegramMessageKey(chatId: number, messageId: number): string {
  return createHash('sha256').update(`telegram:${chatId}:${messageId}`).digest('base64url');
}

export function telegramUpdateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export function isPairingCommand(text: string | undefined, code: string): boolean {
  if (!text) return false;
  const [command, suppliedCode, ...extra] = text.trim().split(/\s+/);
  return /^\/pair(?:@[A-Za-z0-9_]+)?$/i.test(command ?? '') && suppliedCode === code && extra.length === 0;
}
