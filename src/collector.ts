import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { TOKEN_PATH, SELF_CHAT_TITLE, EXTENSION_ID } from './paths.js';
import { openLibrary } from './library.js';

const PORT = Number(process.env.REEL_TO_CODEX_PORT ?? 8787);
const MAX_BODY_BYTES = 40_000;
const library = await openLibrary();
let token: string;
try {
  token = (await readFile(TOKEN_PATH, 'utf8')).trim();
} catch {
  process.stderr.write('Collector token is missing. Run `npm run setup` first.\n');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) {
  process.stderr.write('Collector token is invalid. Run `npm run setup` again.\n');
  process.exit(1);
}

function send(res: ServerResponse, status: number, value: unknown, origin?: string): void {
  if (origin === `chrome-extension://${EXTENSION_ID}`) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function validExtensionOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === `chrome-extension://${EXTENSION_ID}`;
}

function authorized(req: IncomingMessage): boolean {
  const value = req.headers.authorization ?? '';
  return value === `Bearer ${token}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_body');
  return body as Record<string, unknown>;
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!validExtensionOrigin(req)) {
    send(res, 403, { error: 'forbidden_origin' });
    return;
  }
  if (req.method === 'OPTIONS' && req.url?.startsWith('/v1/')) {
    if (origin !== `chrome-extension://${EXTENSION_ID}`) {
      send(res, 403, { error: 'forbidden_origin' });
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { ok: true, service: 'reel-to-codex-collector' }, origin);
    return;
  }
  if (!req.url?.startsWith('/v1/')) {
    send(res, 404, { error: 'not_found' }, origin);
    return;
  }
  if (!authorized(req)) {
    send(res, 401, { error: 'unauthorized' }, origin);
    return;
  }
  try {
    if (req.method === 'GET' && req.url === '/v1/state') {
      const state = library.getState();
      send(res, 200, state, origin);
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/tasks')) {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const status = url.searchParams.get('status') ?? undefined;
      send(res, 200, { tasks: library.listTasks(limit, status) }, origin);
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/outbox')) {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      send(res, 200, { items: library.getOutbox(limit) }, origin);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/heartbeat') {
      const body = await readJson(req);
      if (body.chatTitle !== SELF_CHAT_TITLE) {
        send(res, 400, { error: 'invalid_chat' }, origin);
        return;
      }
      library.markCollectorSeen(SELF_CHAT_TITLE);
      send(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/baseline') {
      const body = await readJson(req);
      if (body.chatTitle !== SELF_CHAT_TITLE || !(body.messageKey === null || typeof body.messageKey === 'string')) {
        send(res, 400, { error: 'invalid_baseline' }, origin);
        return;
      }
      library.setBaseline(body.chatTitle, body.messageKey as string | null);
      send(res, 200, { ok: true, cursor: body.messageKey }, origin);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/events') {
      const body = await readJson(req);
      if (body.chatTitle !== SELF_CHAT_TITLE || typeof body.messageKey !== 'string' || typeof body.text !== 'string') {
        send(res, 400, { error: 'invalid_event' }, origin);
        return;
      }
      const result = library.ingest({
        chatTitle: body.chatTitle,
        messageKey: body.messageKey,
        text: body.text,
        ...(typeof body.observedAt === 'string' ? { observedAt: body.observedAt } : {}),
      });
      send(res, 200, { ok: true, ...result }, origin);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/outbox/claim') {
      const body = await readJson(req);
      if (body.chatTitle !== SELF_CHAT_TITLE) {
        send(res, 400, { error: 'invalid_outbound_request' }, origin);
        return;
      }
      const item = library.claimNextOutbound(SELF_CHAT_TITLE);
      send(res, 200, { ok: true, item }, origin);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/outbox/sent') {
      const body = await readJson(req);
      if (body.chatTitle !== SELF_CHAT_TITLE || typeof body.outboxId !== 'string' || typeof body.messageKey !== 'string') {
        send(res, 400, { error: 'invalid_outbound_result' }, origin);
        return;
      }
      library.markOutboundSent(body.outboxId, body.messageKey);
      send(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/outbox/failed') {
      const body = await readJson(req);
      if (body.chatTitle !== SELF_CHAT_TITLE || typeof body.outboxId !== 'string') {
        send(res, 400, { error: 'invalid_outbound_result' }, origin);
        return;
      }
      library.markOutboundFailed(body.outboxId);
      send(res, 200, { ok: true }, origin);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/cursor-gap') {
      const body = await readJson(req);
      if (body.chatTitle !== SELF_CHAT_TITLE) {
        send(res, 400, { error: 'invalid_chat' }, origin);
        return;
      }
      library.setCollectorError('cursor_gap');
      send(res, 200, { ok: true, error: 'cursor_gap' }, origin);
      return;
    }
    send(res, 404, { error: 'not_found' }, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'collector_error';
    const code = ['body_too_large', 'invalid_body'].includes(message) ? message : 'invalid_request';
    send(res, 400, { error: code }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`Collector listening on http://127.0.0.1:${PORT} (loopback only).\n`);
});

function shutdown(): void {
  server.close(() => {
    library.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
