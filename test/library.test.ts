import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeLibrary } from '../src/library.js';
import { SELF_CHAT_TITLE } from '../src/paths.js';

const messageKey = (value: string) => createHash('sha256').update(value).digest('base64url');
const link = 'https://www.instagram.com/reel/ORCH_123/?igsh=tracking';

test('stores a Reel and consecutive exact instructions, then exposes FTS search', () => {
  const library = new KnowledgeLibrary(':memory:');
  const reel = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('reel-1'), text: `Save ${link}`, observedAt: '2026-11-16T10:00:00Z' });
  assert.equal(reel.kind, 'reel');
  assert.equal(reel.itemIds.length, 1);
  const id = reel.itemIds[0]!;

  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('instruction-1'), text: 'Research the agent orchestration technique.', observedAt: '2026-11-16T10:01:00Z' }).kind, 'instruction');
  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('instruction-2'), text: 'Compare it with our current workflow.', observedAt: '2026-11-16T10:02:00Z' }).kind, 'instruction');
  assert.deepEqual(library.getInstructions(id), [
    { content: 'Research the agent orchestration technique.', receivedAt: '2026-11-16T10:01:00.000Z' },
    { content: 'Compare it with our current workflow.', receivedAt: '2026-11-16T10:02:00.000Z' },
  ]);
  assert.equal(library.search('agent orchestration').length, 1);
  const item = library.getItem(id)!;
  assert.equal(item.originalUrl, link);
  assert.equal(item.canonicalUrl, 'https://www.instagram.com/reel/ORCH_123/');
  library.close();
});

test('a second Reel becomes active; multiple links clear the active item to avoid wrong association', () => {
  const library = new KnowledgeLibrary(':memory:');
  library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('one'), text: link, observedAt: '2026-11-16T10:00:00Z' });
  const second = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('two'), text: 'https://instagram.com/reel/SECOND', observedAt: '2026-11-16T10:01:00Z' });
  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('after-two'), text: 'Attach this to the second one.', observedAt: '2026-11-16T10:02:00Z' }).itemIds[0], second.itemIds[0]);

  const multi = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('multi'), text: 'https://instagram.com/reel/THIRD https://instagram.com/reel/FOURTH', observedAt: '2026-11-16T10:03:00Z' });
  assert.equal(multi.itemIds.length, 2);
  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('ambiguous-followup'), text: 'This association is unclear.', observedAt: '2026-11-16T10:04:00Z' }).kind, 'ignored');
  assert.equal(library.getInstructions(multi.itemIds[0]!).length, 0);
  library.close();
});

test('deduplicates across process restarts and records migration version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reel-to-codex-'));
  const path = join(dir, 'library.sqlite');
  try {
    const first = new KnowledgeLibrary(path);
    const key = messageKey('stable-message-id');
    assert.equal(first.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: key, text: link }).duplicate, false);
    first.close();

    const reopened = new KnowledgeLibrary(path);
    assert.equal(reopened.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: key, text: link }).duplicate, true);
    assert.equal((reopened.db.prepare('SELECT count(*) AS n FROM source_items').get() as { n: number }).n, 1);
    assert.deepEqual(reopened.db.prepare('SELECT version FROM schema_migrations').all(), [{ version: 1 }]);
    assert.deepEqual(reopened.db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects other chat titles including Meta AI and does not retain unrelated messages', () => {
  const library = new KnowledgeLibrary(':memory:');
  assert.throws(() => library.ingest({ chatTitle: 'Meta AI', messageKey: messageKey('meta'), text: link }));
  assert.throws(() => library.ingest({ chatTitle: 'A contact', messageKey: messageKey('contact'), text: 'private text' }));
  assert.equal((library.db.prepare('SELECT count(*) AS n FROM source_events').get() as { n: number }).n, 0);
  assert.equal((library.db.prepare('SELECT count(*) AS n FROM source_items').get() as { n: number }).n, 0);
  library.close();
});

test('discards self-chat text when no Reel is active while advancing only the single resume cursor', () => {
  const library = new KnowledgeLibrary(':memory:');
  library.setBaseline(SELF_CHAT_TITLE, null);
  const key = messageKey('irrelevant-self-chat-message');
  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: key, text: 'A note unrelated to any Reel.' }).kind, 'ignored');
  assert.equal(library.getState().cursor, key);
  assert.equal((library.db.prepare('SELECT count(*) AS n FROM source_events').get() as { n: number }).n, 0);
  assert.equal((library.db.prepare('SELECT count(*) AS n FROM instructions').get() as { n: number }).n, 0);
  library.close();
});

test('invalid input fails without advancing the cursor; done and cancel commands close an active item', () => {
  const library = new KnowledgeLibrary(':memory:');
  library.setBaseline(SELF_CHAT_TITLE, null);
  const before = library.getState().cursor;
  assert.throws(() => library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: 'bad', text: 'bad' }));
  assert.equal(library.getState().cursor, before);

  const itemId = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('done-item'), text: link }).itemIds[0]!;
  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('done-command'), text: '/done' }).kind, 'command');
  assert.equal((library.getItem(itemId) as { status: string }).status, 'done');
  const cancelId = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('cancel-item'), text: 'https://instagram.com/reel/CANCEL' }).itemIds[0]!;
  library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('cancel-command'), text: '/cancel' });
  assert.equal((library.getItem(cancelId) as { status: string }).status, 'cancelled');
  library.close();
});
