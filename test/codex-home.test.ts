import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gatewayAuthLinkTarget, isolatedCodexEnvironment, prepareGatewayCodexHome } from '../src/codex-home.js';

test('gateway Codex home is isolated, exposes only the local knowledge MCP, and omits host secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-home-test-'));
  const sourceHome = join(dir, 'source');
  await mkdir(sourceHome, { mode: 0o700 });
  const sourceAuth = join(sourceHome, 'auth.json');
  await writeFile(sourceAuth, '{"auth_mode":"chatgpt"}\n', { mode: 0o600 });
  const originalKey = process.env.OPENAI_API_KEY;
  const originalSocket = process.env.SSH_AUTH_SOCK;
  process.env.OPENAI_API_KEY = 'must-not-cross-boundary';
  process.env.SSH_AUTH_SOCK = '/tmp/private-agent.sock';
  try {
    const home = await prepareGatewayCodexHome(join(dir, 'data'), resolve(process.cwd()), sourceHome);
    const config = await (await import('node:fs/promises')).readFile(join(home, 'config.toml'), 'utf8');
    const env = isolatedCodexEnvironment(home, '/usr/local/bin/codex');
    assert.match(config, /\[mcp_servers\.reel-to-codex\]/);
    assert.doesNotMatch(config, /cua_repl|slack|github|plugins/i);
    assert.match(config, /\[permissions\.gateway-readonly\.network\][\s\S]*?enabled = false/);
    assert.match(config, /\[permissions\.gateway-project\.network\][\s\S]*?enabled = false/);
    assert.equal(await gatewayAuthLinkTarget(home), await realpath(sourceAuth));
    assert.equal(env.CODEX_HOME, home);
    assert.equal(env.HOME, home);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.REEL_TO_CODEX_DATA_DIR, undefined);
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = originalSocket;
    await rm(dir, { recursive: true, force: true });
  }
});
