import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TelegramApi } from '../src/telegram/api.js';
import { KnowledgeLibrary } from '../src/library.js';
import { SELF_CHAT_TITLE, TELEGRAM_CHAT_TITLE } from '../src/paths.js';
import { isPairingCommand, messageText, ownerPrivateMessage, telegramMessageKey, telegramUpdateTime } from '../src/telegram/updates.js';
import type { TelegramOwner } from '../src/telegram/local-state.js';
import type { TelegramUpdate } from '../src/telegram/api.js';

const owner: TelegramOwner = { chatId: 555, userId: 555, pairedAt: '2026-01-01T00:00:00.000Z' };

function update(overrides: Partial<TelegramUpdate['message']> = {}): TelegramUpdate {
  return {
    update_id: 9,
    message: {
      message_id: 21,
      date: 1_800_000_000,
      chat: { id: 555, type: 'private' },
      from: { id: 555, is_bot: false },
      text: 'hello',
      ...overrides,
    },
  };
}

test('Telegram owner filter accepts only the paired private chat and user', () => {
  assert.equal(ownerPrivateMessage(update(), owner)?.text, 'hello');
  assert.equal(ownerPrivateMessage(update({ chat: { id: 555, type: 'group' } }), owner), null);
  assert.equal(ownerPrivateMessage(update({ chat: { id: 777, type: 'private' } }), owner), null);
  assert.equal(ownerPrivateMessage(update({ from: { id: 777, is_bot: false } }), owner), null);
  assert.equal(ownerPrivateMessage(update({ from: { id: 555, is_bot: true } }), owner), null);
});

test('pairing accepts only the exact one-time private command and normalizes supported message data', () => {
  assert.equal(isPairingCommand('/pair AbC_123', 'AbC_123'), true);
  assert.equal(isPairingCommand('/pair@my_gateway_bot AbC_123', 'AbC_123'), true);
  assert.equal(isPairingCommand('/pair AbC_123 extra', 'AbC_123'), false);
  assert.equal(isPairingCommand('/pair wrong', 'AbC_123'), false);
  assert.equal(messageText(update().message!), 'hello');
  const captionUpdate = update({ caption: 'photo caption' });
  delete captionUpdate.message!.text;
  assert.equal(messageText(captionUpdate.message!), 'photo caption');
  assert.equal(telegramMessageKey(555, 21).length, 43);
  assert.equal(telegramUpdateTime(1_800_000_000), new Date(1_800_000_000_000).toISOString());
});

test('Telegram adapter uses offset-based long polling for message updates and sends to the private chat ID', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; parameters: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split('/').at(-1)!;
    const parameters = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ method, parameters });
    const result = method === 'sendMessage' ? { message_id: 201, date: 1_800_000_000, chat: { id: 555, type: 'private' } } : [];
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const api = new TelegramApi('123456:fake-token-for-test');
    await api.getUpdates(123, 25);
    await api.sendMessage(555, 'hello');
    assert.deepEqual(requests[0], { method: 'getUpdates', parameters: { offset: 123, timeout: 25, allowed_updates: ['message'] } });
    assert.deepEqual(requests[1], { method: 'sendMessage', parameters: { chat_id: 555, text: 'hello' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Telegram tasks and outbound messages stay isolated from legacy WhatsApp outbox rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-telegram-library-'));
  const library = new KnowledgeLibrary(join(dir, 'knowledge.sqlite'));
  try {
    library.setAgentChatMode(true);
    const key = telegramMessageKey(555, 101);
    const ingested = library.ingest({
      chatTitle: TELEGRAM_CHAT_TITLE,
      transport: 'telegram',
      messageKey: key,
      text: '/research Compare two open-source data tools.',
    });
    assert.equal(ingested.kind, 'command');
    assert.equal(ingested.duplicate, false);
    assert.equal(library.ingest({
      chatTitle: TELEGRAM_CHAT_TITLE,
      transport: 'telegram',
      messageKey: key,
      text: '/research Compare two open-source data tools.',
    }).duplicate, true);
    assert.equal(library.getTask(ingested.taskId!)?.transport, 'telegram');
    assert.equal(library.ingest({
      chatTitle: SELF_CHAT_TITLE,
      transport: 'whatsapp',
      messageKey: createHash('sha256').update('wa-message').digest('base64url'),
      text: '/research Legacy message.',
    }).duplicate, false);

    const telegramTestId = library.createOutboundTest('telegram');
    const whatsappTestId = library.createOutboundTest('whatsapp');
    const telegramClaim = library.claimNextOutbound(TELEGRAM_CHAT_TITLE, 'telegram');
    assert.equal(telegramClaim?.id, telegramTestId);
    assert.notEqual(telegramClaim?.id, whatsappTestId);
    const whatsappClaim = library.claimNextOutbound(SELF_CHAT_TITLE, 'whatsapp');
    assert.equal(whatsappClaim?.id, whatsappTestId);

    library.markOutboundSent(telegramTestId, createHash('sha256').update('telegram-sent').digest('base64url'));
    assert.equal((library.db.prepare("SELECT value FROM settings WHERE key='outbound_enabled_telegram'").get() as { value: string }).value, '1');
    assert.equal(library.db.prepare("SELECT 1 FROM settings WHERE key='outbound_enabled'").get(), undefined);
  } finally {
    library.close();
    await rm(dir, { recursive: true, force: true });
  }
});
