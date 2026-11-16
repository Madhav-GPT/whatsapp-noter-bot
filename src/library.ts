import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdir, chmod } from 'node:fs/promises';
import { DATABASE_PATH, DATA_DIR, SELF_CHAT_TITLE } from './paths.js';
import { extractReelLinks, isInstructionCommand } from './reels.js';

export interface InboundMessage {
  chatTitle: string;
  messageKey: string;
  text: string;
  observedAt?: string;
}

export type GatewayTaskStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'needs_resume';

export interface GatewayTask {
  id: string;
  requestText: string;
  status: GatewayTaskStatus;
  threadId: string | null;
  intent: string;
  sourceMessageKey: string;
  createdAt: string;
  updatedAt: string;
  result: string | null;
  error: string | null;
}

export interface LibraryStatus {
  initialized: boolean;
  cursor: string | null;
  lastSeenAt: string | null;
  collectorRunning: boolean;
  selfChatTitle: string;
  lastError: string | null;
  lastChatVerifiedAt: string | null;
}

export class KnowledgeLibrary {
  readonly db: Database.Database;

  constructor(path = DATABASE_PATH) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collector_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        initialized INTEGER NOT NULL DEFAULT 0,
        cursor_key TEXT,
        last_seen_at TEXT,
        last_chat_verified_at TEXT,
        last_error TEXT
      );
      INSERT OR IGNORE INTO collector_state(id) VALUES (1);
      CREATE TABLE IF NOT EXISTS source_items (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL DEFAULT 'instagram_reel',
        original_url TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        shortcode TEXT NOT NULL,
        original_message TEXT NOT NULL,
        source_message_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','done','cancelled','error')) DEFAULT 'pending',
        received_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_message_key, canonical_url)
      );
      CREATE TABLE IF NOT EXISTS instructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        message_key TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        evidence_level TEXT NOT NULL CHECK(evidence_level IN ('confirmed_source','researched','unverified')),
        content TEXT NOT NULL,
        source_url TEXT,
        source_title TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
        source_attribution TEXT NOT NULL,
        intended_purpose TEXT NOT NULL,
        dependencies TEXT NOT NULL DEFAULT '[]',
        security_considerations TEXT NOT NULL DEFAULT '',
        installation_steps TEXT NOT NULL DEFAULT '',
        compatibility_assumptions TEXT NOT NULL DEFAULT '',
        validation_requirements TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_events (
        message_key TEXT PRIMARY KEY,
        event_kind TEXT NOT NULL,
        item_id TEXT REFERENCES source_items(id) ON DELETE SET NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        item_id UNINDEXED, content, tokenize='unicode61'
      );
      CREATE INDEX IF NOT EXISTS source_items_status_received ON source_items(status, received_at DESC);
      CREATE INDEX IF NOT EXISTS instructions_item_received ON instructions(item_id, received_at);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
      `);
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_tasks (
        id TEXT PRIMARY KEY,
        source_message_key TEXT NOT NULL UNIQUE,
        request_text TEXT NOT NULL,
        intent TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_approval','completed','failed','cancelled','needs_resume')) DEFAULT 'queued',
        thread_id TEXT,
        source_item_id TEXT REFERENCES source_items(id) ON DELETE SET NULL,
        continuation_of TEXT REFERENCES gateway_tasks(id) ON DELETE SET NULL,
        project_alias TEXT REFERENCES gateway_projects(alias) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS gateway_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES gateway_tasks(id) ON DELETE CASCADE,
        event_kind TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_approvals (
        code TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES gateway_tasks(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        request_method TEXT NOT NULL,
        details TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired')) DEFAULT 'pending',
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS gateway_outbox (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES gateway_tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        delivery_state TEXT NOT NULL CHECK(delivery_state IN ('local_pending','sending','sent','failed')) DEFAULT 'local_pending',
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE(task_id, body_hash)
      );
      CREATE TABLE IF NOT EXISTS gateway_projects (
        alias TEXT PRIMARY KEY,
        local_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gateway_tasks_status_created ON gateway_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS gateway_task_events_task_created ON gateway_task_events(task_id, created_at);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'));
      `);
      const outboxColumns = this.db.pragma('table_info(gateway_outbox)') as Array<{ name: string }>;
      if (!outboxColumns.some((column) => column.name === 'delivery_kind')) {
        this.db.exec("ALTER TABLE gateway_outbox ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'local' CHECK(delivery_kind IN ('local','test','auto'))");
      }
      if (!outboxColumns.some((column) => column.name === 'sent_message_key')) {
        this.db.exec('ALTER TABLE gateway_outbox ADD COLUMN sent_message_key TEXT');
      }
      this.db.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'))");
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getState(): Pick<LibraryStatus, 'initialized' | 'cursor' | 'lastSeenAt' | 'lastError' | 'lastChatVerifiedAt'> {
    const row = this.db.prepare('SELECT initialized, cursor_key, last_seen_at, last_chat_verified_at, last_error FROM collector_state WHERE id=1').get() as {
      initialized: number; cursor_key: string | null; last_seen_at: string | null; last_chat_verified_at: string | null; last_error: string | null;
    };
    return { initialized: row.initialized === 1, cursor: row.cursor_key, lastSeenAt: row.last_seen_at, lastError: row.last_error, lastChatVerifiedAt: row.last_chat_verified_at };
  }

  setBaseline(chatTitle: string, cursor: string | null): void {
    if (chatTitle !== SELF_CHAT_TITLE) throw new Error('Self-chat title did not match the configured title.');
    if (cursor !== null && !/^[A-Za-z0-9_-]{43}$/.test(cursor)) throw new Error('Invalid cursor hash.');
    this.db.prepare(`UPDATE collector_state SET initialized=1, cursor_key=?, last_seen_at=?, last_chat_verified_at=?, last_error=NULL WHERE id=1`)
      .run(cursor, new Date().toISOString(), new Date().toISOString());
  }

  markCollectorSeen(chatTitle: string): void {
    if (chatTitle !== SELF_CHAT_TITLE) throw new Error('Self-chat title did not match the configured title.');
    this.db.prepare('UPDATE collector_state SET last_chat_verified_at=? WHERE id=1').run(new Date().toISOString());
  }

  setCollectorError(code: string): void {
    const safeCode = /^[a-z0-9_-]{1,64}$/i.test(code) ? code : 'collector_error';
    this.db.prepare('UPDATE collector_state SET last_error=? WHERE id=1').run(safeCode);
  }

  ingest(message: InboundMessage): { duplicate: boolean; kind: 'reel' | 'instruction' | 'task' | 'command' | 'ignored'; itemIds: string[]; taskId?: string; cursor: string } {
    if (message.chatTitle !== SELF_CHAT_TITLE) throw new Error('Self-chat title did not match the configured title.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(message.messageKey)) throw new Error('Invalid message key hash.');
    if (message.text.length > 10000) throw new Error('Message exceeds the allowed length.');

    const receivedAt = message.observedAt && Number.isFinite(Date.parse(message.observedAt))
      ? new Date(message.observedAt).toISOString()
      : new Date().toISOString();
    const links = extractReelLinks(message.text);

    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT 1 FROM source_events WHERE message_key=?').get(message.messageKey);
      if (prior) {
        this.updateCursor(message.messageKey, receivedAt);
        return { duplicate: true, kind: 'ignored' as const, itemIds: [], cursor: message.messageKey };
      }
      if (this.db.prepare('SELECT 1 FROM gateway_outbox WHERE sent_message_key=?').get(message.messageKey)) {
        this.updateCursor(message.messageKey, receivedAt);
        return { duplicate: true, kind: 'ignored' as const, itemIds: [], cursor: message.messageKey };
      }
      if (/^(?:🤖\s*)?Codex:/i.test(message.text.trim())) {
        this.updateCursor(message.messageKey, receivedAt);
        return { duplicate: true, kind: 'ignored' as const, itemIds: [], cursor: message.messageKey };
      }

      let kind: 'reel' | 'instruction' | 'task' | 'command' | 'ignored' = 'ignored';
      const itemIds: string[] = [];
      let taskId: string | undefined;
      if (links.length > 0) {
        kind = 'reel';
        const now = receivedAt;
        const create = this.db.prepare(`INSERT OR IGNORE INTO source_items
          (id, original_url, canonical_url, shortcode, original_message, source_message_key, received_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const link of links) {
          const existing = this.db.prepare('SELECT id FROM source_items WHERE source_message_key=? AND canonical_url=?').get(message.messageKey, link.canonicalUrl) as { id: string } | undefined;
          const id = existing?.id ?? crypto.randomUUID();
          create.run(id, link.originalUrl, link.canonicalUrl, link.shortcode, message.text, message.messageKey, receivedAt, now, now);
          itemIds.push(id);
          this.indexItem(id, `${link.originalUrl}\n${message.text}`);
        }
        const urls = message.text.match(/https?:\/\/[^\s]+/gi) ?? [];
        const hasNonReelUrl = urls.some((url) => extractReelLinks(url).length === 0);
        if (hasNonReelUrl || /\b(research|analy[sz]e|summari[sz]e|compare|explain|find|review|prepare|draft|investigate)\b/i.test(message.text)) {
          kind = 'task';
          taskId = this.createTask(message.messageKey, message.text, receivedAt, itemIds.length === 1 ? itemIds[0] ?? null : null);
        }
        this.setActive(itemIds.length === 1 ? itemIds[0] ?? null : null);
      } else {
        const slash = this.handleGatewayCommand(message.text, message.messageKey, receivedAt);
        if (slash) {
          kind = 'command';
          const created = this.db.prepare('SELECT id FROM gateway_tasks WHERE source_message_key=?').get(message.messageKey) as { id: string } | undefined;
          if (created) taskId = created.id;
        }
        const command = slash ? null : isInstructionCommand(message.text);
        const activeId = this.getActiveItem(receivedAt);
        if (slash) {
          // Gateway commands are handled by the durable task controller.
        } else if (command && activeId) {
          kind = 'command';
          const status = command === 'done' ? 'done' : 'cancelled';
          this.db.prepare('UPDATE source_items SET status=?, updated_at=? WHERE id=?').run(status, receivedAt, activeId);
          this.setActive(null);
          itemIds.push(activeId);
        } else if (message.text.trim() && activeId) {
          kind = 'instruction';
          this.db.prepare('INSERT INTO instructions(item_id, message_key, content, received_at) VALUES (?, ?, ?, ?)')
            .run(activeId, message.messageKey, message.text, receivedAt);
          this.db.prepare('UPDATE source_items SET updated_at=? WHERE id=?').run(receivedAt, activeId);
          this.indexItem(activeId, message.text);
          itemIds.push(activeId);
          kind = 'task';
          taskId = this.createTask(message.messageKey, message.text, receivedAt, activeId, this.findContinuationTarget(message.text, receivedAt));
          this.queueProjectApprovalNotice(taskId, receivedAt);
        } else if (message.text.trim()) {
          kind = 'task';
          taskId = this.createTask(message.messageKey, message.text, receivedAt, null, this.findContinuationTarget(message.text, receivedAt));
          this.queueProjectApprovalNotice(taskId, receivedAt);
        }
      }

      if (kind !== 'ignored') {
        this.db.prepare('INSERT INTO source_events(message_key, event_kind, item_id, received_at) VALUES (?, ?, ?, ?)')
          .run(message.messageKey, kind, itemIds[0] ?? null, receivedAt);
      }
      this.updateCursor(message.messageKey, receivedAt);
      return { duplicate: false, kind, itemIds, ...(taskId ? { taskId } : {}), cursor: message.messageKey };
    })();
  }

  private handleGatewayCommand(text: string, sourceKey: string, at: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return false;
    const [command, ...args] = trimmed.split(/\s+/);
    const taskId = args[0] ?? '';
    if (command === '/done' || command === '/cancel') return false;
    if (command === '/help') {
      this.queueOutbox(null, 'Commands: /help, /status, /pause, /resume, /stop <task-id>, /continue <task-id> <follow-up>, /project <alias> <request>, /approve <code>, /deny <code>. Results are also available locally with `npm run gateway:inbox`.', at);
      return true;
    }
    if (command === '/status') {
      const active = this.listTasks(5);
      const paused = this.isPaused();
      const summary = active.map((task) => `${task.id.slice(0, 8)} ${task.status}: ${task.requestText.slice(0, 90)}`).join('\n') || 'No recent tasks.';
      this.queueOutbox(null, `Gateway ${paused ? 'paused' : 'running'}\n${summary}`, at);
      return true;
    }
    if (command === '/pause') {
      this.setPaused(true);
      this.queueOutbox(null, 'Gateway paused. New messages will be saved; Codex work will not start.', at);
      return true;
    }
    if (command === '/resume' && taskId) {
      const resumed = this.resumeTask(taskId);
      this.queueOutbox(null, resumed ? `Task ${taskId.slice(0, 8)} queued to resume.` : 'Task not found or not recoverable. Use /status to check.', at);
      return true;
    }
    if (command === '/resume') {
      this.setPaused(false);
      this.queueOutbox(null, 'Gateway resumed. Queued tasks can now run.', at);
      return true;
    }
    if (command === '/stop' && taskId) {
      const found = this.cancelTask(taskId);
      this.queueOutbox(null, found ? `Task ${taskId.slice(0, 8)} cancelled.` : 'Task not found.', at);
      return true;
    }
    if (command === '/continue' && taskId && args.length > 1) {
      const previous = this.getTask(taskId);
      if (!previous) this.queueOutbox(null, 'Task not found. Use /status to see recent task IDs.', at);
      else {
        const followup = args.slice(1).join(' ');
        const id = this.createTask(sourceKey, followup, at, null, previous.id);
        const created = this.getTask(id);
        this.queueOutbox(id, created?.intent.startsWith('project:')
          ? `Project continuation ${id.slice(0, 8)} is awaiting explicit local approval. Review it with npm run gateway:inbox.`
          : `Continuing task ${previous.id.slice(0, 8)}. New task ${id.slice(0, 8)} queued.`, at);
      }
      return true;
    }
    if (command === '/project' && args.length > 1) {
      const alias = args[0]!.toLowerCase();
      const project = this.getProject(alias);
      if (!project) this.queueOutbox(null, `Unknown project alias: ${alias}. Register it locally first with npm run gateway:project -- add ${alias} /path/to/project.`, at);
      else {
        const request = args.slice(1).join(' ');
        const id = this.createTask(sourceKey, request, at, null, undefined, alias);
        this.queueOutbox(id, `Project task ${id.slice(0, 8)} is awaiting explicit local approval before it starts. Review with npm run gateway:inbox.`, at);
      }
      return true;
    }
    if ((command === '/approve' || command === '/deny') && taskId) {
      const approval = this.resolveApproval(taskId, command === '/approve') || (command === '/approve' && this.approveProjectTask(taskId));
      this.queueOutbox(null, approval ? `${command === '/approve' ? 'Approved' : 'Denied'} request ${taskId}.` : 'Approval code is missing, expired, or already resolved.', at);
      return true;
    }
    if (command === '/codex' && args.length) {
      const id = this.createTask(sourceKey, args.join(' '), at, null);
      this.queueOutbox(id, `Task ${id.slice(0, 8)} queued.`, at);
      return true;
    }
    this.queueOutbox(null, 'Unknown command. Send /help for the command list.', at);
    return true;
  }

  private createTask(sourceKey: string, text: string, at = new Date().toISOString(), sourceItemId: string | null = null, continuationOf?: string, projectAlias?: string): string {
    const id = randomUUID();
    const requestText = continuationOf ? `Continue task ${continuationOf}. Prior context: continue the same investigation and use the earlier findings.\n\nFollow-up: ${text}` : text;
    const inheritedProject = projectAlias ? null : continuationOf
      ? this.db.prepare('SELECT project_alias AS projectAlias FROM gateway_tasks WHERE id=?').get(continuationOf) as { projectAlias: string | null } | undefined
      : undefined;
    const scopedProjectAlias = projectAlias ?? inheritedProject?.projectAlias ?? undefined;
    const intent = scopedProjectAlias ? `project:${scopedProjectAlias}` : /https?:\/\/github\.com\//i.test(text) ? 'repository' : /https?:\/\//i.test(text) || /\b(research|investigate|compare|pricing|technical report|source attribution)\b/i.test(text) ? 'research' : 'general';
    const priorThread = continuationOf ? this.getTask(continuationOf)?.threadId ?? null : null;
    this.db.prepare(`INSERT INTO gateway_tasks(id,source_message_key,request_text,intent,status,source_item_id,continuation_of,project_alias,thread_id,created_at,updated_at)
      VALUES(?,?,?,?, ?,?,?,?,?,?,?)`).run(id, sourceKey, requestText, intent, scopedProjectAlias ? 'waiting_approval' : 'queued', sourceItemId, continuationOf ?? null, scopedProjectAlias ?? null, priorThread, at, at);
    if (scopedProjectAlias) {
      this.db.prepare('INSERT INTO gateway_task_events(task_id,event_kind,content,created_at) VALUES(?,?,?,?)').run(id, 'approval_required', 'Project access requires explicit approval for this task.', at);
    } else {
      this.db.prepare('INSERT INTO gateway_task_events(task_id,event_kind,content,created_at) VALUES(?,?,?,?)').run(id, 'queued', 'Accepted from the configured WhatsApp self-chat.', at);
    }
    return id;
  }

  private queueProjectApprovalNotice(taskId: string, at: string): void {
    const task = this.getTask(taskId);
    if (task?.intent.startsWith('project:')) {
      this.queueOutbox(taskId, `Project continuation ${taskId.slice(0, 8)} is awaiting explicit approval before Codex can continue. Review it with npm run gateway:inbox.`, at);
    }
  }

  private findContinuationTarget(text: string, at: string): string | undefined {
    if (!/^(?:compare|continue|follow[ -]?up|now|also|what about|how does|relate|expand)\b|\b(previous research|earlier research|that report|those findings|same topic)\b/i.test(text.trim())) return undefined;
    const cutoff = new Date(Date.parse(at) - 24 * 60 * 60 * 1000).toISOString();
    const candidates = this.db.prepare(`SELECT id FROM gateway_tasks WHERE status='completed' AND thread_id IS NOT NULL AND completed_at>=?
      ORDER BY completed_at DESC LIMIT 2`).all(cutoff) as Array<{ id: string }>;
    return candidates.length === 1 ? candidates[0]!.id : undefined;
  }

  enqueueTask(sourceKey: string, text: string, at?: string): string {
    const existing = this.db.prepare('SELECT id FROM gateway_tasks WHERE source_message_key=?').get(sourceKey) as { id: string } | undefined;
    return existing?.id ?? this.createTask(sourceKey, text, at);
  }

  listTasks(limit = 20, status?: string): GatewayTask[] {
    const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
    const rows = status
      ? this.db.prepare(`SELECT * FROM gateway_tasks WHERE status=? ORDER BY created_at DESC LIMIT ?`).all(status, bounded)
      : this.db.prepare(`SELECT * FROM gateway_tasks ORDER BY created_at DESC LIMIT ?`).all(bounded);
    return rows.map((row) => this.taskFromRow(row as Record<string, unknown>));
  }

  getTask(idPrefix: string): GatewayTask | null {
    const rows = this.db.prepare('SELECT * FROM gateway_tasks WHERE id=? OR id LIKE ? ORDER BY created_at DESC LIMIT 2').all(idPrefix, `${idPrefix}%`) as Record<string, unknown>[];
    return rows.length === 1 ? this.taskFromRow(rows[0]!) : null;
  }

  private taskFromRow(row: Record<string, unknown>): GatewayTask {
    return { id: String(row.id), requestText: String(row.request_text), status: String(row.status) as GatewayTaskStatus,
      threadId: row.thread_id ? String(row.thread_id) : null, intent: String(row.intent), sourceMessageKey: String(row.source_message_key),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), result: row.result ? String(row.result) : null, error: row.error ? String(row.error) : null };
  }

  claimNextTask(): GatewayTask | null {
    if (this.isPaused()) return null;
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM gateway_tasks WHERE status='queued' ORDER BY created_at LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const at = new Date().toISOString();
      this.db.prepare("UPDATE gateway_tasks SET status='running',started_at=COALESCE(started_at,?),updated_at=?,attempts=attempts+1 WHERE id=? AND status='queued'").run(at, at, row.id);
      this.db.prepare('INSERT INTO gateway_task_events(task_id,event_kind,content,created_at) VALUES(?,?,?,?)').run(row.id, 'started', 'Codex App Server turn started.', at);
      return this.getTask(String(row.id));
    })();
  }

  setTaskThread(id: string, threadId: string): void { this.db.prepare('UPDATE gateway_tasks SET thread_id=?,updated_at=? WHERE id=?').run(threadId, new Date().toISOString(), id); }
  appendTaskEvent(id: string, kind: string, content: string): void {
    this.db.prepare('INSERT INTO gateway_task_events(task_id,event_kind,content,created_at) VALUES(?,?,?,?)').run(id, kind, content.slice(0, 10000), new Date().toISOString());
  }
  finishTask(id: string, status: 'completed' | 'failed' | 'needs_resume', result: string | null, error?: string): void {
    const at = new Date().toISOString();
    this.db.prepare('UPDATE gateway_tasks SET status=?,result=?,error=?,updated_at=?,completed_at=? WHERE id=?').run(status, result, error ?? null, at, status === 'completed' || status === 'failed' ? at : null, id);
    this.appendTaskEvent(id, status, error ?? (result ?? ''));
    if (result) {
      this.db.prepare('INSERT INTO knowledge_fts(item_id,content) VALUES(?,?)').run(id, result);
      const reply = result.length > 3000 ? `${result.slice(0, 2950)}\n\nFull report is saved locally. Use /status to see the task ID.` : result;
      this.queueOutbox(id, reply, at);
    }
  }
  cancelTask(idPrefix: string): boolean {
    const task = this.getTask(idPrefix);
    if (!task || ['completed','failed','cancelled'].includes(task.status)) return false;
    const at = new Date().toISOString();
    this.db.prepare("UPDATE gateway_tasks SET status='cancelled',updated_at=?,completed_at=? WHERE id=?").run(at, at, task.id);
    this.appendTaskEvent(task.id, 'cancelled', 'Cancelled by explicit user command.');
    return true;
  }
  markInterrupted(): void {
    const at = new Date().toISOString();
    this.db.prepare("UPDATE gateway_tasks SET status='needs_resume',updated_at=? WHERE status='running'").run(at);
    this.db.prepare(`UPDATE gateway_tasks SET status='needs_resume',updated_at=? WHERE status='waiting_approval' AND
      (intent NOT LIKE 'project:%' OR EXISTS (SELECT 1 FROM gateway_approvals a WHERE a.task_id=gateway_tasks.id AND a.state='pending'))`).run(at);
    this.db.prepare("UPDATE gateway_approvals SET state='expired',resolved_at=? WHERE state='pending'").run(at);
    this.db.prepare("UPDATE gateway_outbox SET delivery_state='failed' WHERE delivery_state='sending'").run();
  }
  isPaused(): boolean { return (this.db.prepare("SELECT value FROM settings WHERE key='gateway_paused'").get() as { value: string } | undefined)?.value === '1'; }
  setPaused(paused: boolean): void { this.db.prepare("INSERT INTO settings(key,value) VALUES('gateway_paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(paused ? '1' : '0'); }
  queueOutbox(taskId: string | null, body: string, at = new Date().toISOString(), deliveryKind?: 'local' | 'test' | 'auto'): string {
    const id = randomUUID();
    const enabled = (this.db.prepare("SELECT value FROM settings WHERE key='outbound_enabled'").get() as { value: string } | undefined)?.value === '1';
    const kind = deliveryKind ?? (enabled ? 'auto' : 'local');
    const outgoingBody = kind === 'auto' && !/^(?:🤖\s*)?Codex:/i.test(body) ? `Codex: ${body}` : body;
    const bodyHash = createHash('sha256').update(outgoingBody).digest('base64url');
    this.db.prepare("INSERT OR IGNORE INTO gateway_outbox(id,task_id,body,body_hash,delivery_state,created_at,delivery_kind) VALUES(?,?,?,?, 'local_pending',?,?)").run(id, taskId, outgoingBody.slice(0, 10000), bodyHash, at, kind);
    const row = this.db.prepare('SELECT id FROM gateway_outbox WHERE task_id IS ? AND body_hash=?').get(taskId, bodyHash) as { id: string };
    return row.id;
  }
  getOutbox(limit = 50): unknown[] { return this.db.prepare('SELECT id,task_id AS taskId,body,delivery_state AS deliveryState,delivery_kind AS deliveryKind,created_at AS createdAt FROM gateway_outbox ORDER BY created_at DESC LIMIT ?').all(Math.min(200, limit)); }
  createOutboundTest(): string {
    return this.queueOutbox(null, 'Codex: WhatsApp to Codex gateway test. Outbound self-chat delivery is active.', new Date().toISOString(), 'test');
  }
  claimOutbound(id: string, chatTitle: string): { id: string; body: string } | null {
    if (chatTitle !== SELF_CHAT_TITLE) throw new Error('Self-chat title did not match the configured title.');
    return this.db.transaction(() => {
      const enabled = (this.db.prepare("SELECT value FROM settings WHERE key='outbound_enabled'").get() as { value: string } | undefined)?.value === '1';
      const row = this.db.prepare(`SELECT id,body FROM gateway_outbox WHERE id=? AND delivery_state='local_pending'
        AND (delivery_kind='test' OR (delivery_kind='auto' AND ?=1))`).get(id, enabled ? 1 : 0) as { id: string; body: string } | undefined;
      if (!row) return null;
      const last = (this.db.prepare("SELECT value FROM settings WHERE key='outbound_last_attempt_at'").get() as { value: string } | undefined)?.value;
      if (last && Date.now() - Date.parse(last) < 60_000) return null;
      const changed = this.db.prepare("UPDATE gateway_outbox SET delivery_state='sending' WHERE id=? AND delivery_state='local_pending'").run(id);
      if (changed.changes !== 1) return null;
      this.db.prepare("INSERT INTO settings(key,value) VALUES('outbound_last_attempt_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
      return row;
    })();
  }
  claimNextOutbound(chatTitle: string): { id: string; body: string } | null {
    if (chatTitle !== SELF_CHAT_TITLE) throw new Error('Self-chat title did not match the configured title.');
    const enabled = (this.db.prepare("SELECT value FROM settings WHERE key='outbound_enabled'").get() as { value: string } | undefined)?.value === '1';
    const row = this.db.prepare(`SELECT id FROM gateway_outbox WHERE delivery_state='local_pending'
      AND (delivery_kind='test' OR (delivery_kind='auto' AND ?=1)) ORDER BY CASE delivery_kind WHEN 'test' THEN 0 ELSE 1 END,created_at LIMIT 1`).get(enabled ? 1 : 0) as { id: string } | undefined;
    return row ? this.claimOutbound(row.id, chatTitle) : null;
  }
  markOutboundSent(id: string, messageKey: string): void {
    if (!/^[A-Za-z0-9_-]{43}$/.test(messageKey)) throw new Error('Invalid outbound message key hash.');
    const at = new Date().toISOString();
    const result = this.db.prepare("UPDATE gateway_outbox SET delivery_state='sent',sent_at=?,sent_message_key=? WHERE id=? AND delivery_state='sending'").run(at, messageKey, id);
    if (result.changes !== 1) throw new Error('Outbound message is not in sending state.');
    this.db.prepare("INSERT INTO settings(key,value) VALUES('outbound_last_sent_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(at);
    const row = this.db.prepare('SELECT delivery_kind FROM gateway_outbox WHERE id=?').get(id) as { delivery_kind: string };
    if (row.delivery_kind === 'test') this.db.prepare("INSERT INTO settings(key,value) VALUES('outbound_enabled','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
  }
  markOutboundFailed(id: string): void {
    this.db.prepare("UPDATE gateway_outbox SET delivery_state='failed' WHERE id=? AND delivery_state='sending'").run(id);
  }
  getTaskDetails(idPrefix: string): Record<string, unknown> | null {
    const task = this.getTask(idPrefix);
    if (!task) return null;
    const events = this.db.prepare('SELECT event_kind AS kind,content,created_at AS createdAt FROM gateway_task_events WHERE task_id=? ORDER BY created_at').all(task.id);
    const approvals = this.db.prepare('SELECT code,request_method AS method,details,state,created_at AS createdAt FROM gateway_approvals WHERE task_id=? ORDER BY created_at').all(task.id);
    return { ...task, events, approvals };
  }
  searchTasks(query: string, limit = 10): unknown[] {
    const bounded = Math.min(50, Math.max(1, Math.trunc(limit)));
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');
    if (!terms) return [];
    return this.db.prepare(`SELECT DISTINCT t.id,t.request_text AS requestText,t.status,t.intent,t.created_at AS createdAt,
      snippet(knowledge_fts,1,'[',']','…',12) AS snippet FROM knowledge_fts JOIN gateway_tasks t ON t.id=knowledge_fts.item_id
      WHERE knowledge_fts MATCH ? ORDER BY t.created_at DESC LIMIT ?`).all(terms,bounded) as unknown[];
  }
  createApproval(taskId: string, requestId: string | number, method: string, details: unknown): string {
    const code = randomBytes(4).toString('hex').toUpperCase();
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO gateway_approvals(code,task_id,request_id,request_method,details,created_at) VALUES(?,?,?,?,?,?)').run(code, taskId, String(requestId), method, JSON.stringify(details).slice(0, 10000), at);
    this.db.prepare("UPDATE gateway_tasks SET status='waiting_approval',updated_at=? WHERE id=?").run(at, taskId);
    this.appendTaskEvent(taskId, 'approval_required', `${method}: ${JSON.stringify(details).slice(0, 2000)}`);
    this.queueOutbox(taskId, `Codex is waiting for permission. Review task ${taskId.slice(0,8)} and request ${code} locally with npm run gateway:inbox. Reply /approve ${code} or /deny ${code}; nothing is auto-approved.`);
    return code;
  }
  resolveApproval(code: string, approved: boolean): boolean {
    const result = this.db.prepare("UPDATE gateway_approvals SET state=?,resolved_at=? WHERE code=? AND state='pending'").run(approved ? 'approved' : 'denied', new Date().toISOString(), code.toUpperCase());
    return result.changes === 1;
  }
  approveProjectTask(idPrefix: string): boolean {
    const task = this.getTask(idPrefix);
    if (!task || task.status !== 'waiting_approval' || !task.intent.startsWith('project:')) return false;
    this.db.prepare("UPDATE gateway_tasks SET status='queued',updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
    this.appendTaskEvent(task.id, 'project_approved', 'User explicitly approved this task for read-write access scoped to the registered project directory.');
    return true;
  }
  isProjectTaskApproved(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM gateway_task_events WHERE task_id=? AND event_kind='project_approved' LIMIT 1").get(id));
  }
  resumeTask(idPrefix: string): boolean {
    const task = this.getTask(idPrefix);
    if (!task || task.status !== 'needs_resume') return false;
    this.db.prepare("UPDATE gateway_tasks SET status='queued',updated_at=? WHERE id=?").run(new Date().toISOString(), task.id);
    this.appendTaskEvent(task.id, 'resumed', 'User explicitly requested recovery of the Codex task.');
    return true;
  }
  pendingApprovals(): unknown[] { return this.db.prepare("SELECT code,task_id AS taskId,request_method AS method,details,created_at AS createdAt FROM gateway_approvals WHERE state='pending' ORDER BY created_at").all(); }
  getProject(alias: string): { alias: string; localPath: string } | null {
    const row = this.db.prepare('SELECT alias,local_path AS localPath FROM gateway_projects WHERE alias=?').get(alias) as { alias: string; localPath: string } | undefined;
    return row ?? null;
  }
  addProject(alias: string, path: string): void { this.db.prepare('INSERT INTO gateway_projects(alias,local_path,created_at) VALUES(?,?,?)').run(alias, path, new Date().toISOString()); }
  listProjects(): unknown[] { return this.db.prepare('SELECT alias,local_path AS localPath,created_at AS createdAt FROM gateway_projects ORDER BY alias').all(); }

  private updateCursor(cursor: string, at: string): void {
    this.db.prepare(`UPDATE collector_state SET initialized=1, cursor_key=?, last_seen_at=?, last_chat_verified_at=?, last_error=NULL WHERE id=1`)
      .run(cursor, at, new Date().toISOString());
  }

  private setActive(itemId: string | null): void {
    this.db.prepare(`INSERT INTO settings(key,value) VALUES ('active_item_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(itemId ?? '');
  }

  private getActiveItem(now: string): string | null {
    const active = this.db.prepare(`SELECT value FROM settings WHERE key='active_item_id'`).get() as { value: string } | undefined;
    if (!active?.value) return null;
    const item = this.db.prepare('SELECT status, received_at FROM source_items WHERE id=?').get(active.value) as { status: string; received_at: string } | undefined;
    if (!item || item.status !== 'pending' || Date.parse(now) - Date.parse(item.received_at) > 24 * 60 * 60 * 1000) {
      this.setActive(null);
      return null;
    }
    return active.value;
  }

  private indexItem(itemId: string, content: string): void {
    this.db.prepare('INSERT INTO knowledge_fts(item_id,content) VALUES (?,?)').run(itemId, content);
  }

  search(query: string, limit = 10, status?: string): unknown[] {
    const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
    const terms = query.trim().split(/\s+/).filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ');
    if (!terms) return [];
    const sql = `SELECT DISTINCT i.id, i.original_url AS originalUrl, i.canonical_url AS canonicalUrl,
      i.status, i.received_at AS receivedAt, snippet(knowledge_fts, 1, '[', ']', '…', 12) AS snippet
      FROM knowledge_fts JOIN source_items i ON i.id=knowledge_fts.item_id
      WHERE knowledge_fts MATCH ? ${status ? 'AND i.status=?' : ''}
      ORDER BY i.received_at DESC LIMIT ?`;
    return (status
      ? this.db.prepare(sql).all(terms, status, boundedLimit)
      : this.db.prepare(sql).all(terms, boundedLimit)) as unknown[];
  }

  getItem(id: string): Record<string, unknown> | null {
    const item = this.db.prepare(`SELECT id, source_type AS sourceType, original_url AS originalUrl, canonical_url AS canonicalUrl,
      shortcode, original_message AS originalMessage, status, received_at AS receivedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM source_items WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    if (!item) return null;
    return { ...item, instructions: this.getInstructions(id), findings: this.getFindings(id), skillCandidates: this.getSkillCandidates(id) };
  }

  listItems(limit = 10, status?: string): unknown[] {
    const bounded = Math.min(50, Math.max(1, Math.trunc(limit)));
    return (status
      ? this.db.prepare(`SELECT id, original_url AS originalUrl, canonical_url AS canonicalUrl, status, received_at AS receivedAt FROM source_items WHERE status=? ORDER BY received_at DESC LIMIT ?`).all(status, bounded)
      : this.db.prepare(`SELECT id, original_url AS originalUrl, canonical_url AS canonicalUrl, status, received_at AS receivedAt FROM source_items ORDER BY received_at DESC LIMIT ?`).all(bounded)) as unknown[];
  }

  getInstructions(id: string): unknown[] {
    return this.db.prepare('SELECT content, received_at AS receivedAt FROM instructions WHERE item_id=? ORDER BY received_at').all(id) as unknown[];
  }

  getFindings(id: string): unknown[] {
    return this.db.prepare(`SELECT evidence_level AS evidenceLevel, content, source_url AS sourceUrl, source_title AS sourceTitle, created_at AS createdAt FROM findings WHERE item_id=? ORDER BY created_at`).all(id) as unknown[];
  }

  getSkillCandidates(itemId?: string): unknown[] {
    const query = `SELECT id, item_id AS itemId, source_attribution AS sourceAttribution, intended_purpose AS intendedPurpose,
      dependencies, security_considerations AS securityConsiderations, installation_steps AS installationSteps,
      compatibility_assumptions AS compatibilityAssumptions, validation_requirements AS validationRequirements,
      status, created_at AS createdAt FROM skill_candidates ${itemId ? 'WHERE item_id=?' : ''} ORDER BY created_at DESC`;
    return (itemId ? this.db.prepare(query).all(itemId) : this.db.prepare(query).all()) as unknown[];
  }

  getCollectorStatus(running = false): LibraryStatus {
    const state = this.getState();
    const fresh = state.lastChatVerifiedAt !== null && Date.now() - Date.parse(state.lastChatVerifiedAt) < 20_000;
    return { ...state, collectorRunning: running || fresh, selfChatTitle: SELF_CHAT_TITLE };
  }

  close(): void { this.db.close(); }
}

export async function openLibrary(): Promise<KnowledgeLibrary> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700);
  await mkdir(dirname(DATABASE_PATH), { recursive: true, mode: 0o700 });
  const library = new KnowledgeLibrary(DATABASE_PATH);
  await chmod(DATABASE_PATH, 0o600);
  return library;
}
