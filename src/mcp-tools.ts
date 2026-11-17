import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { KnowledgeLibrary } from './library.js';

const outputSchema = z.object({ data: z.unknown() });

function register(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodType,
  handler: (input: Record<string, unknown>) => unknown,
): void {
  server.registerTool(name, { description, inputSchema, outputSchema }, async (input) => {
    const data = handler(input as Record<string, unknown>);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { data } };
  });
}

export function createMcpServer(library: KnowledgeLibrary): McpServer {
  const server = new McpServer({ name: 'reel-to-codex', version: '1.0.0' }, { capabilities: { tools: {} } });
  register(server, 'search_knowledge', 'Search saved Instagram Reels, exact instructions, and recorded findings.', z.object({
    query: z.string().min(1).max(500),
    status: z.enum(['pending', 'done', 'cancelled', 'error']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }), ({ query, status, limit }) => library.search(String(query), Number(limit ?? 10), typeof status === 'string' ? status : undefined));

  register(server, 'get_knowledge_item', 'Get a saved Reel, its original message, instructions, findings, and skill candidates.', z.object({ id: z.string().min(1).max(100) }), ({ id }) => library.getItem(String(id)) ?? { error: 'not_found' });
  register(server, 'list_recent_items', 'List recent saved Reel items.', z.object({ limit: z.number().int().min(1).max(50).optional() }), ({ limit }) => library.listItems(Number(limit ?? 10)));
  register(server, 'list_pending_items', 'List Reel items still awaiting review.', z.object({}), () => library.listItems(50, 'pending'));
  register(server, 'get_item_instructions', 'Get the exact follow-up instructions saved for one Reel.', z.object({ id: z.string().min(1).max(100) }), ({ id }) => library.getInstructions(String(id)));
  register(server, 'get_skill_candidates', 'List proposed skill candidates with their attribution and review requirements.', z.object({ itemId: z.string().min(1).max(100).optional() }), ({ itemId }) => library.getSkillCandidates(typeof itemId === 'string' ? itemId : undefined));
  register(server, 'get_collector_status', 'Read local collector health and the most recent verified self-chat poll time.', z.object({}), () => library.getCollectorStatus());
  register(server, 'list_gateway_tasks', 'List recent Codex gateway tasks and their durable statuses.', z.object({
    limit: z.number().int().min(1).max(100).optional(),
    status: z.enum(['queued','running','waiting_approval','completed','failed','cancelled','needs_resume']).optional(),
  }), ({ limit, status }) => library.listTasks(Number(limit ?? 20), typeof status === 'string' ? status : undefined));
  register(server, 'get_gateway_task', 'Read one gateway task, its saved result, events, and approval history.', z.object({ id: z.string().min(1).max(100) }), ({ id }) => library.getTaskDetails(String(id)) ?? { error: 'not_found_or_ambiguous' });
  register(server, 'search_gateway_tasks', 'Search completed gateway task requests and saved research reports.', z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }), ({ query, limit }) => library.searchTasks(String(query), Number(limit ?? 10)));
  register(server, 'search_notes', 'Search personal notes saved from ordinary WhatsApp self-chat messages.', z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }), ({ query, limit }) => library.searchNotes(String(query), Number(limit ?? 10)));
  register(server, 'list_recent_notes', 'List recent personal notes saved by the gateway.', z.object({ limit: z.number().int().min(1).max(100).optional() }), ({ limit }) => library.listNotes(Number(limit ?? 20)));
  register(server, 'get_note', 'Read one saved personal note by its ID or unique prefix.', z.object({ id: z.string().min(1).max(100) }), ({ id }) => library.getNote(String(id)) ?? { error: 'not_found_or_ambiguous' });
  return server;
}
