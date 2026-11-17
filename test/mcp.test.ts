import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { KnowledgeLibrary } from '../src/library.js';
import { SELF_CHAT_TITLE } from '../src/paths.js';
import { createMcpServer } from '../src/mcp-tools.js';

test('MCP advertises and runs read-only structured knowledge tools', async () => {
  const library = new KnowledgeLibrary(':memory:');
    library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: createHash('sha256').update('mcp-note').digest('base64url'), text: 'Remember this quiet work block.' });
  const hash = createHash('sha256').update('mcp-item').digest('base64url');
  library.ingest({ chatTitle: SELF_CHAT_TITLE, messageKey: hash, text: 'https://instagram.com/reel/MCP_ORCH' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const server = createMcpServer(library);
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('search_knowledge'));
    assert.ok(names.includes('get_knowledge_item'));
    assert.ok(names.includes('get_collector_status'));
    assert.ok(names.includes('search_notes'));

    const search = await client.callTool({ name: 'search_knowledge', arguments: { query: 'MCP_ORCH' } });
    assert.ok(search.structuredContent);
    const data = (search.structuredContent as { data: unknown[] }).data;
    assert.equal(data.length, 1);

    const notes = await client.callTool({ name: 'search_notes', arguments: { query: 'quiet work' } });
    assert.equal((notes.structuredContent as { data: unknown[] }).data.length, 1);
    const collectorStatus = await client.callTool({ name: 'get_collector_status', arguments: {} });
    assert.equal(JSON.stringify(collectorStatus.structuredContent).includes(SELF_CHAT_TITLE), false, 'private configured chat title must not be exposed to the model');
  } finally {
    await client.close();
    await server.close();
    library.close();
  }
});
