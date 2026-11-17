import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TurnMonitor } from '../src/turn-monitor.js';

function notification(method: string, params: Record<string, unknown>) {
  return { method, params };
}

test('captures the exact completed final-answer item when turn/completed contains no items', async () => {
  const server = new EventEmitter();
  const progress: string[] = [];
  const monitor = new TurnMonitor(server, {
    taskId: 'task-1', threadId: 'thread-1', executionTimeoutMs: 1000, approvalTimeoutMs: 1000,
    onProgress: (text) => progress.push(text),
  });
  monitor.setTurnId('turn-1');
  server.emit('notification', notification('item/agentMessage/delta', { threadId: 'other-thread', turnId: 'turn-1', itemId: 'x', delta: 'wrong thread' }));
  server.emit('notification', notification('item/completed', { threadId: 'thread-1', turnId: 'other-turn', item: { id: 'x', type: 'agentMessage', phase: 'final_answer', text: 'wrong turn' } }));
  server.emit('notification', notification('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: 'intermediate commentary' } }));
  server.emit('notification', notification('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'Captured response.' }));
  server.emit('notification', notification('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Captured response.' } }));
  server.emit('notification', notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } }));

  const outcome = await monitor.completion;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result, 'Captured response.');
  assert.deepEqual(progress, ['Captured response.']);
  assert.equal(server.listenerCount('notification'), 0);
  assert.equal(server.listenerCount('exit'), 0);
});

test('ignores malformed notifications and reports App Server failures with their error text', async () => {
  const server = new EventEmitter();
  const monitor = new TurnMonitor(server, { taskId: 'task-2', threadId: 'thread-2', executionTimeoutMs: 1000, approvalTimeoutMs: 1000 });
  monitor.setTurnId('turn-2');
  server.emit('notification', notification('item/completed', { threadId: 'thread-2', turnId: 'turn-2', item: { type: 'agentMessage', text: 'missing item id' } }));
  server.emit('notification', notification('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-other', status: 'failed' } }));
  server.emit('notification', notification('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-2', status: 'failed', error: { message: 'Research was rejected.' } } }));
  const outcome = await monitor.completion;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'Research was rejected.');
  assert.equal(outcome.result, '');
  assert.equal(server.listenerCount('notification'), 0);
});

test('pauses the active-work timeout during approval and removes listeners on timeout', async () => {
  const server = new EventEmitter();
  const monitor = new TurnMonitor(server, { taskId: 'task-3', threadId: 'thread-3', executionTimeoutMs: 25, approvalTimeoutMs: 100 });
  monitor.setTurnId('turn-3');
  monitor.setApprovalPending(true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  monitor.setApprovalPending(false);
  const eventLoopKeeper = setTimeout(() => {}, 1000);
  const outcome = await monitor.completion;
  clearTimeout(eventLoopKeeper);
  assert.equal(outcome.status, 'timeout');
  assert.equal(server.listenerCount('notification'), 0);
  assert.equal(server.listenerCount('exit'), 0);
});
