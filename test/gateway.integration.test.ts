import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('local gateway runs a self-chat task through Codex App Server and saves its result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whatsapp-codex-gateway-'));
  const port = await freePort();
  const token = randomBytes(32).toString('base64url');
  const title = 'Message Yourself (You)';
  const fakeCodex = join(dir, 'fake-codex');
  const appServerLog = join(dir, 'app-server.jsonl');
  const projectDirectory = join(dir, 'approved-project');
  await mkdir(projectDirectory);
  const projectPath = await realpath(projectDirectory);
  const fakeServer = `#!/usr/bin/env node
if (process.argv[2] === 'mcp' && process.argv[3] === 'list') { process.stdout.write(JSON.stringify({ servers: [] })); process.exit(0); }
const readline = require('node:readline');
const fs = require('node:fs');
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  fs.appendFileSync(process.env.GATEWAY_TEST_LOG, JSON.stringify(msg) + '\\n');
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'gateway-test' } });
  else if (msg.method === 'plugin/installed') send({ jsonrpc: '2.0', id: msg.id, result: { marketplaces: [] } });
  else if (msg.method === 'thread/start') send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'thread-gateway-test' } } });
  else if (msg.method === 'thread/resume') send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId } } });
  else if (msg.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 'turn-gateway-test' } } });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-gateway-test', turn: { id: 'turn-gateway-test' } } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-gateway-test', turn: { id: 'turn-gateway-test', status: 'completed', items: [{ type: 'agentMessage', text: 'Example report. Source: https://example.com' }] } } });
    }, 25);
  } else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported test method' } });
});
`;
  await writeFile(join(dir, 'collector-token'), `${token}\n`, { mode: 0o600 });
  await chmod(join(dir, 'collector-token'), 0o600);
  await writeFile(fakeCodex, fakeServer, { mode: 0o700 });
  await chmod(fakeCodex, 0o700);

  const child = spawn(process.execPath, [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'src/service.ts')], {
    cwd: process.cwd(),
    env: { ...process.env, REEL_TO_CODEX_DATA_DIR: dir, REEL_TO_CODEX_PORT: String(port), REEL_TO_CODEX_SELF_CHAT_TITLE: title, CODEX_BIN: fakeCodex, GATEWAY_TEST_LOG: appServerLog },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      try {
        if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(250) })).ok) { ready = true; break; }
      } catch { /* service is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `Gateway did not start: ${output}`);

    const messageKey = createHash('sha256').update('example-research-task').digest('base64url');
    const request = { chatTitle: title, messageKey, text: 'Research this website and prepare a structured technical report: https://example.com' };
    const accepted = await fetch(`${base}/v1/events`, { method: 'POST', headers: auth, body: JSON.stringify(request) });
    const acceptedBody = await accepted.json() as { kind: string; duplicate: boolean; taskId: string };
    assert.equal(acceptedBody.kind, 'task');
    assert.equal(acceptedBody.duplicate, false);

    const duplicate = await fetch(`${base}/v1/events`, { method: 'POST', headers: auth, body: JSON.stringify(request) });
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);

    let task: { status: string; result: string | null } | undefined;
    for (let i = 0; i < 80; i += 1) {
      const response = await fetch(`${base}/v1/tasks?limit=10`, { headers: { Authorization: `Bearer ${token}` } });
      const tasks = await response.json() as { tasks: Array<{ id: string; status: string; result: string | null }> };
      task = tasks.tasks.find((candidate) => candidate.id === acceptedBody.taskId);
      if (task?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(task?.status, 'completed', `Task did not finish: ${output}`);
    assert.match(task?.result ?? '', /Source: https:\/\/example\.com/);
    const outbox = await fetch(`${base}/v1/outbox`, { headers: { Authorization: `Bearer ${token}` } });
    const inbox = await outbox.json() as { items: Array<{ body: string; deliveryState: string; deliveryKind: string }> };
    assert.equal(inbox.items[0]?.deliveryState, 'local_pending');
    assert.equal(inbox.items[0]?.deliveryKind, 'local');

    const db = new Database(join(dir, 'knowledge.sqlite'));
    try { db.prepare('INSERT INTO gateway_projects(alias,local_path,created_at) VALUES(?,?,?)').run('demo', projectPath, new Date().toISOString()); }
    finally { db.close(); }
    const projectRequestKey = createHash('sha256').update('approved-project-task').digest('base64url');
    const projectAccepted = await fetch(`${base}/v1/events`, { method: 'POST', headers: auth, body: JSON.stringify({ chatTitle: title, messageKey: projectRequestKey, text: '/project demo update the project README' }) });
    const projectTaskId = (await projectAccepted.json() as { taskId: string }).taskId;
    await new Promise((resolve) => setTimeout(resolve, 650));
    const beforeApproval = (await readFile(appServerLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    assert.equal(beforeApproval.filter((message) => message.method === 'thread/start').length, 1, 'project task must wait for approval before App Server starts it');

    const approvalKey = createHash('sha256').update('approve-project-task').digest('base64url');
    const approved = await fetch(`${base}/v1/events`, { method: 'POST', headers: auth, body: JSON.stringify({ chatTitle: title, messageKey: approvalKey, text: `/approve ${projectTaskId.slice(0, 8)}` }) });
    assert.equal((await approved.json() as { kind: string }).kind, 'command');
    let projectTask: { status: string } | undefined;
    for (let i = 0; i < 80; i += 1) {
      const response = await fetch(`${base}/v1/tasks?limit=10`, { headers: { Authorization: `Bearer ${token}` } });
      const tasks = await response.json() as { tasks: Array<{ id: string; status: string }> };
      projectTask = tasks.tasks.find((candidate) => candidate.id === projectTaskId);
      if (projectTask?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(projectTask?.status, 'completed', `Approved project task did not finish: ${output}`);
    const requests = (await readFile(appServerLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const projectThread = requests.find((message) => message.method === 'thread/start' && message.params?.cwd === projectPath);
    assert.equal(projectThread?.params?.sandbox, 'workspace-write');
    const projectTurn = requests.find((message) => message.method === 'turn/start' && message.params?.cwd === projectPath);
    assert.deepEqual(projectTurn?.params?.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [projectPath], networkAccess: false });
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref();
    });
    await rm(dir, { recursive: true, force: true });
  }
});
