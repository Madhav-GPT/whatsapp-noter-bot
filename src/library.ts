import Database from 'better-sqlite3';
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

  ingest(message: InboundMessage): { duplicate: boolean; kind: 'reel' | 'instruction' | 'command' | 'ignored'; itemIds: string[]; cursor: string } {
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

      let kind: 'reel' | 'instruction' | 'command' | 'ignored' = 'ignored';
      const itemIds: string[] = [];
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
        this.setActive(itemIds.length === 1 ? itemIds[0] ?? null : null);
      } else {
        const command = isInstructionCommand(message.text);
        const activeId = this.getActiveItem(receivedAt);
        if (command && activeId) {
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
        }
      }

      if (kind !== 'ignored') {
        this.db.prepare('INSERT INTO source_events(message_key, event_kind, item_id, received_at) VALUES (?, ?, ?, ?)')
          .run(message.messageKey, kind, itemIds[0] ?? null, receivedAt);
      }
      this.updateCursor(message.messageKey, receivedAt);
      return { duplicate: false, kind, itemIds, cursor: message.messageKey };
    })();
  }

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
