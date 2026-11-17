import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the configured MCP entry launches over stdio and serves tools without a collector process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reel-to-codex-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'), join(process.cwd(), 'src/mcp.ts')],
    cwd: process.cwd(),
    env: { ...getDefaultEnvironment(), REEL_TO_CODEX_DATA_DIR: dir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 13);
    const status = await client.callTool({ name: 'get_collector_status', arguments: {} });
    assert.ok(status.structuredContent);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
