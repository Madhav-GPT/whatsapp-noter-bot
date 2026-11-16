import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { EXTENSION_ID } from '../src/paths.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('loopback collector requires its token and accepts only the configured self-chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reel-to-codex-http-'));
  const port = await freePort();
  const token = randomBytes(32).toString('base64url');
  await writeFile(join(dir, 'collector-token'), `${token}\n`, { mode: 0o600 });
  await chmod(join(dir, 'collector-token'), 0o600);
  const child = spawn(process.execPath, [
    join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
    join(process.cwd(), 'src/collector.ts'),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, REEL_TO_CODEX_DATA_DIR: dir, REEL_TO_CODEX_PORT: String(port), REEL_TO_CODEX_SELF_CHAT_TITLE: 'Message Yourself (You)' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}` };

  try {
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(250) });
        if (response.ok) { ready = true; break; }
      } catch { /* server is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `Collector did not start: ${output}`);

    const forbiddenOrigin = await fetch(`${base}/v1/state`, { headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
    assert.equal(forbiddenOrigin.status, 403);
    const missingToken = await fetch(`${base}/v1/state`, { headers: { Origin: `chrome-extension://${EXTENSION_ID}` } });
    assert.equal(missingToken.status, 401);

    const otherChat = await fetch(`${base}/v1/events`, {
      method: 'POST', headers: { ...auth, Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatTitle: 'Meta AI', messageKey: createHash('sha256').update('outside').digest('base64url'), text: 'https://instagram.com/reel/OUTSIDE' }),
    });
    assert.equal(otherChat.status, 400);

    const messageKey = createHash('sha256').update('self-chat-test').digest('base64url');
    const eventBody = { chatTitle: 'Message Yourself (You)', messageKey, text: 'https://instagram.com/reel/HTTP_TEST' };
    const accepted = await fetch(`${base}/v1/events`, {
      method: 'POST', headers: { ...auth, Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    });
    assert.equal(accepted.status, 200);
    const result = await accepted.json() as { kind: string; itemIds: string[]; duplicate: boolean };
    assert.equal(result.kind, 'reel');
    assert.equal(result.itemIds.length, 1);
    assert.equal(result.duplicate, false);

    const duplicate = await fetch(`${base}/v1/events`, {
      method: 'POST', headers: { ...auth, Origin: `chrome-extension://${EXTENSION_ID}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(eventBody),
    });
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000).unref();
    });
    await rm(dir, { recursive: true, force: true });
  }
});
