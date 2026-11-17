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
  library.setAgentChatMode(true);
  const reel = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('reel-1'), text: `Save ${link}`, observedAt: '2026-11-16T10:00:00Z' });
  assert.equal(reel.kind, 'reel');
  assert.equal(reel.itemIds.length, 1);
  const id = reel.itemIds[0]!;

  const firstTask = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('instruction-1'), text: 'Research the agent orchestration technique.', observedAt: '2026-11-16T10:01:00Z' });
  const secondTask = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('instruction-2'), text: 'Compare it with our current workflow.', observedAt: '2026-11-16T10:02:00Z' });
  assert.equal(firstTask.kind, 'task');
  assert.equal(secondTask.kind, 'task');
  assert.ok(firstTask.taskId);
  assert.equal(library.listTasks().length, 2);
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

test('a second Reel becomes active; ambiguous context is queued as a general task, not lost', () => {
  const library = new KnowledgeLibrary(':memory:');
  library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('one'), text: link, observedAt: '2026-11-16T10:00:00Z' });
  const second = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('two'), text: 'https://instagram.com/reel/SECOND', observedAt: '2026-11-16T10:01:00Z' });
  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('after-two'), text: 'Attach this to the second one.', observedAt: '2026-11-16T10:02:00Z' }).itemIds[0], second.itemIds[0]);

  library.setAgentChatMode(true);
  const multi = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('multi'), text: 'https://instagram.com/reel/THIRD https://instagram.com/reel/FOURTH', observedAt: '2026-11-16T10:03:00Z' });
  assert.equal(multi.itemIds.length, 2);
  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('ambiguous-followup'), text: 'This association is unclear.', observedAt: '2026-11-16T10:04:00Z' }).kind, 'task');
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
    assert.deepEqual(reopened.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
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

test('safe mode saves standalone self-chat text as a note instead of starting a task', () => {
  const library = new KnowledgeLibrary(':memory:');
  library.setBaseline(SELF_CHAT_TITLE, null);
  const key = messageKey('irrelevant-self-chat-message');
  const result = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: key, text: 'A note unrelated to any Reel.' });
  assert.equal(result.kind, 'note');
  assert.equal(result.taskId, undefined);
  assert.equal(library.getState().cursor, key);
  assert.equal((library.db.prepare('SELECT count(*) AS n FROM source_events').get() as { n: number }).n, 1);
  assert.equal((library.db.prepare('SELECT count(*) AS n FROM gateway_tasks').get() as { n: number }).n, 0);
  assert.equal((library.getNote((library.listNotes()[0] as { id: string }).id)?.content), 'A note unrelated to any Reel.');
  assert.equal(library.searchNotes('unrelated').length, 1);
  assert.equal((library.db.prepare('SELECT count(*) AS n FROM instructions').get() as { n: number }).n, 0);
  library.close();
});

test('task queue survives restart, deduplicates on message key, and supports pause, cancel, and saved results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reel-to-codex-tasks-'));
  const path = join(dir, 'library.sqlite');
  try {
    const first = new KnowledgeLibrary(path);
    first.setBaseline(SELF_CHAT_TITLE, null);
    const key = messageKey('gateway-research-request');
    const accepted = first.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: key, text: '/research Research https://example.com and prepare a report.' });
    assert.equal(accepted.kind, 'command');
    assert.ok(accepted.taskId);
    assert.equal(first.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: key, text: 'duplicate request' }).duplicate, true);
    first.setPaused(true);
    assert.equal(first.claimNextTask(), null);
    first.setPaused(false);
    const claimed = first.claimNextTask()!;
    assert.equal(claimed.id, accepted.taskId);
    first.setTaskThread(claimed.id, 'thread-research-1');
    first.setTaskTurn(claimed.id, 'turn-research-1');
    first.finishTask(claimed.id, 'completed', '## Report\nSource: https://example.com');
    assert.equal(first.getTask(claimed.id)?.turnId, 'turn-research-1', 'completed tasks retain the final turn association for recovery and audit');
    assert.equal(first.getTask(claimed.id)?.result, '## Report\nSource: https://example.com');
    first.setAgentChatMode(true);
    const followupKey = messageKey('gateway-followup');
    const followup = first.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: followupKey, text: 'Compare it with the previous research.' });
    assert.equal(followup.kind, 'task');
    assert.equal(first.getTask(followup.taskId!)?.threadId, 'thread-research-1');
    assert.equal((first.db.prepare('SELECT continuation_of AS parent FROM gateway_tasks WHERE id=?').get(followup.taskId!) as { parent: string }).parent, claimed.id);
    first.close();

    const reopened = new KnowledgeLibrary(path);
    assert.equal(reopened.getTask(accepted.taskId!)?.status, 'completed');
    assert.match(reopened.getTask(accepted.taskId!)?.result ?? '', /Source: https:\/\/example\.com/);
    const replies = reopened.getOutbox() as Array<{ body: string }>;
    assert.ok(replies.some(({ body }) => body === `Research ${accepted.taskId!.slice(0, 8)} queued.`));
    assert.ok(replies.some(({ body }) => body === `Task ${accepted.taskId!.slice(0, 8)} completed.\n\n## Report\nSource: https://example.com`));
    assert.equal(reopened.searchTasks('Report').length, 1);
    reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('explicit /research creates one task in safe mode and /mode agent enables ordinary task routing', () => {
  const library = new KnowledgeLibrary(':memory:');
  const url = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('plain-url-safe'), text: 'https://example.com' });
  assert.equal(url.kind, 'note');
  const command = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('explicit-research'), text: '/research Summarize https://example.com' });
  assert.equal(command.kind, 'command');
  assert.equal(library.listTasks().length, 1);
  library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('mode-agent'), text: '/mode agent' });
  assert.equal(library.isAgentChatMode(), true);
  const ordinary = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('ordinary-agent'), text: 'Compare the report with our previous result.' });
  assert.equal(ordinary.kind, 'task');
  library.close();
});

test('an explicit Reel research command saves the Reel and associates it with one Codex task', () => {
  const library = new KnowledgeLibrary(':memory:');
  const reelUrl = 'https://www.instagram.com/reel/CODEX_REEL_1/';
  const accepted = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('research-reel-command'), text: `/research Summarize this Reel: ${reelUrl}` });
  assert.equal(accepted.kind, 'command');
  assert.equal(accepted.itemIds.length, 1);
  assert.ok(accepted.taskId);
  assert.equal((library.db.prepare('SELECT source_item_id AS sourceItemId FROM gateway_tasks WHERE id=?').get(accepted.taskId!) as { sourceItemId: string }).sourceItemId, accepted.itemIds[0]);
  assert.equal(library.getItem(accepted.itemIds[0]!)?.originalUrl, reelUrl);
  library.close();
});

test('gateway controls require explicit approval and projects are queued only after user approval', () => {
  const library = new KnowledgeLibrary(':memory:');
  library.addProject('demo', '/tmp/demo-project');
  const projectTask = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('project-task'), text: '/project demo summarize the repository' });
  assert.equal(projectTask.kind, 'command');
  assert.equal(library.getTask(projectTask.taskId!)?.status, 'waiting_approval');
  assert.equal(library.isProjectTaskApproved(projectTask.taskId!), false);
  library.markInterrupted();
  assert.equal(library.getTask(projectTask.taskId!)?.status, 'waiting_approval', 'unapproved project tasks must remain available for approval after restart');
  assert.equal(library.approveProjectTask(projectTask.taskId!.slice(0, 8)), true);
  assert.equal(library.getTask(projectTask.taskId!)?.status, 'queued');
  assert.equal(library.isProjectTaskApproved(projectTask.taskId!), true);
  library.setTaskThread(projectTask.taskId!, 'thread-project');
  library.finishTask(projectTask.taskId!, 'completed', 'Repository summary');

  const continuation = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('project-followup'), text: `/continue ${projectTask.taskId!.slice(0, 8)} update the project` });
  assert.equal(library.getTask(continuation.taskId!)?.status, 'waiting_approval');
  assert.equal(library.getTask(continuation.taskId!)?.threadId, 'thread-project');
  assert.equal(library.getTask(continuation.taskId!)?.intent, 'project:demo');
  assert.equal(library.isProjectTaskApproved(continuation.taskId!), false);
  assert.equal(library.approveProjectTask(continuation.taskId!.slice(0, 8)), true);

  const code = library.createApproval(continuation.taskId!, 'server-request-1', 'item/fileChange/requestApproval', { reason: 'write files' });
  assert.equal(library.pendingApprovals().length, 1);
  assert.equal(library.resolveApproval(code, true), true);
  assert.equal(library.pendingApprovals().length, 0);
  assert.equal(library.resolveApproval(code, true), false);

  assert.equal(library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('gateway-pause'), text: '/pause' }).kind, 'command');
  assert.equal(library.isPaused(), true);
  library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: messageKey('gateway-resume'), text: '/resume' });
  assert.equal(library.isPaused(), false);
  library.close();
});

test('outbound stays local until a one-shot test passes, then rate-limits and suppresses bot echoes', () => {
  const library = new KnowledgeLibrary(':memory:');
  const localId = library.queueOutbox(null, 'local-only result');
  assert.equal((library.db.prepare('SELECT delivery_kind FROM gateway_outbox WHERE id=?').get(localId) as { delivery_kind: string }).delivery_kind, 'local');
  assert.equal(library.claimNextOutbound(SELF_CHAT_TITLE), null);

  const testId = library.createOutboundTest();
  assert.throws(() => library.claimOutbound(testId, 'Other chat'));
  const testItem = library.claimNextOutbound(SELF_CHAT_TITLE)!;
  assert.equal(testItem.id, testId);
  assert.equal(library.claimNextOutbound(SELF_CHAT_TITLE), null);
  const botKey = messageKey('outbound-bot-message');
  library.markOutboundSent(testId, botKey);
  const echoed = library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: botKey, text: testItem.body });
  assert.equal(echoed.kind, 'ignored');
  assert.equal(echoed.duplicate, true);
    assert.equal(library.markOutboundSent(testId, botKey), undefined, 'duplicate receipts for the same verified WhatsApp identity are idempotent');
  assert.equal(library.isPaused(), false);

  const autoId = library.queueOutbox(null, 'A normal result');
  assert.match((library.db.prepare('SELECT body FROM gateway_outbox WHERE id=?').get(autoId) as { body: string }).body, /^Codex:/);
  library.db.prepare("UPDATE settings SET value=? WHERE key='outbound_last_attempt_at'").run(new Date(Date.now() - 61_000).toISOString());
  assert.equal(library.claimNextOutbound(SELF_CHAT_TITLE)?.id, autoId);
  library.close();
});

test('interrupted outbound attempts become uncertain and are never claimed a second time', () => {
  const library = new KnowledgeLibrary(':memory:');
  const id = library.createOutboundTest();
  assert.equal(library.claimOutbound(id, SELF_CHAT_TITLE)?.id, id);
  library.markInterrupted();
  assert.equal((library.getOutbox() as Array<{ id: string; deliveryState: string }>).find((item) => item.id === id)?.deliveryState, 'uncertain');
  assert.equal(library.claimOutbound(id, SELF_CHAT_TITLE), null);
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
