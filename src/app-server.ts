import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

type JsonRpc = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

export class CodexAppServerError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); this.name = 'CodexAppServerError'; }
}

export class CodexAppServerExitedError extends Error {
  constructor(message: string) { super(message); this.name = 'CodexAppServerExitedError'; }
}

export class GatewayToolBoundaryError extends Error {
  constructor(message: string) { super(message); this.name = 'GatewayToolBoundaryError'; }
}

/** Minimal JSONL client for the supported local Codex App Server protocol. */
export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private disabledPluginIds = new Set<string>();

  constructor(private readonly executable = process.env.CODEX_BIN || 'codex', private readonly environment: NodeJS.ProcessEnv = process.env) { super(); }

  get isRunning(): boolean { return this.child !== null && this.child.exitCode === null; }

  async start(): Promise<void> {
    if (this.child) return;
    const names = this.readConfiguredMcpNames();
    if (names.length !== 1 || names[0] !== 'reel-to-codex') throw new GatewayToolBoundaryError('Gateway Codex home must expose only the read-only reel-to-codex MCP server.');
    const auth = spawnSync(this.executable, ['login', 'status'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000, env: this.environment });
    if (auth.error || auth.status !== 0 || !/logged in/i.test(`${auth.stdout ?? ''}\n${auth.stderr ?? ''}`)) {
      throw new Error('The isolated gateway Codex home is not signed in. Run `npm run gateway:login` once, then restart the gateway.');
    }
    const child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], env: this.environment });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.receive(line));
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').slice(0, 2000);
      this.emit('stderr', line);
    });
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code, signal) => {
      this.failAll(new CodexAppServerExitedError(`Codex App Server exited (${code ?? signal ?? 'unknown'}).`));
      this.child = null;
      this.emit('exit', { code, signal });
    });
    try {
      await this.request('initialize', {
        clientInfo: { name: 'whatsapp-noter-bot', title: 'WhatsApp to Codex Gateway', version: '0.2.0' },
        // Named permission profiles and runtime workspace roots are currently part of
        // the installed App Server's experimental capability surface.
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      const installed = await this.request('plugin/installed', {}, 10_000);
      const marketplaces = (installed as { marketplaces?: Array<{ plugins?: Array<{ id?: string; installed?: boolean; enabled?: boolean }> }> })?.marketplaces ?? [];
      const activePlugins = marketplaces.flatMap((marketplace) => marketplace.plugins ?? []).filter((plugin) => plugin.installed && plugin.enabled);
      if (activePlugins.length) throw new GatewayToolBoundaryError('Gateway Codex home unexpectedly contains enabled plugins; refusing to run tasks.');
      for (const plugin of marketplaces.flatMap((marketplace) => marketplace.plugins ?? [])) {
        if (plugin.installed && typeof plugin.id === 'string') this.disabledPluginIds.add(plugin.id);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  getDisabledPluginIds(): string[] { return [...this.disabledPluginIds]; }

  private async readMcpInventory(threadId?: string): Promise<Array<Record<string, unknown>>> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100, ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) }, 15_000);
      const value = result as { data?: unknown; nextCursor?: unknown };
      if (!Array.isArray(value?.data)) throw new GatewayToolBoundaryError('Codex App Server did not return an MCP inventory; refusing to run without a verified tool boundary.');
      all.push(...value.data);
      if (typeof value.nextCursor !== 'string' || !value.nextCursor) { cursor = undefined; break; }
      cursor = value.nextCursor;
      if (page === 9) throw new GatewayToolBoundaryError('Codex App Server MCP inventory exceeded the safe paging limit.');
    }
    if (cursor) throw new GatewayToolBoundaryError('Codex App Server MCP inventory was incomplete.');
    if (all.some((entry) => !entry || typeof entry !== 'object' || typeof (entry as { name?: unknown }).name !== 'string')) {
      throw new GatewayToolBoundaryError('Codex App Server returned a malformed MCP inventory; refusing to run without a verified tool boundary.');
    }
    return all as Array<Record<string, unknown>>;
  }

  async disableUnexpectedPluginMcpServers(threadId: string): Promise<void> {
    const inventory = await this.readMcpInventory(threadId);
    const names = new Set(inventory.map((entry) => String(entry.name)));
    if (!names.has('reel-to-codex')) throw new GatewayToolBoundaryError('The read-only reel-to-codex MCP server is missing from the effective App Server inventory.');
    const knowledgeServer = inventory.find((entry) => entry.name === 'reel-to-codex');
    if (knowledgeServer?.pluginId) throw new GatewayToolBoundaryError('The reel-to-codex server resolved to a plugin provider instead of the isolated local server.');
    const unexpected = inventory.filter((entry) => entry.name !== 'reel-to-codex');
    for (const entry of unexpected) {
      if (typeof entry.pluginId === 'string' && entry.pluginId) this.disabledPluginIds.add(entry.pluginId);
      else if (entry.runtimeStatus !== 'disabled') {
        throw new GatewayToolBoundaryError(`Codex App Server exposed a non-plugin MCP server outside the isolated allowlist (${String(entry.name)}); the task was blocked.`);
      }
    }
  }

  async verifyMcpInventory(threadId: string): Promise<void> {
    const inventory = await this.readMcpInventory(threadId);
    const names = [...new Set(inventory.map((entry) => String(entry.name)))];
    const knowledgeServer = inventory.find((entry) => entry.name === 'reel-to-codex');
    if (names.length !== 1 || names[0] !== 'reel-to-codex' || knowledgeServer?.pluginId || knowledgeServer?.runtimeStatus !== 'connected') {
      throw new GatewayToolBoundaryError(`Codex App Server exposed an unexpected MCP tool set (${names.join(', ') || 'none'}); the task was blocked.`);
    }
  }

  private readConfiguredMcpNames(): string[] {
    const result = spawnSync(this.executable, ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 2_000_000, env: this.environment });
    if (result.error || result.status !== 0) throw new Error('Could not safely enumerate configured MCP servers; refusing to start Codex with inherited tools.');
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error('Codex MCP configuration was not valid JSON; refusing to start with inherited tools.'); }
    const servers = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { servers?: unknown }).servers) ? (parsed as { servers: unknown[] }).servers : null);
    if (!servers) throw new Error('Codex MCP configuration had an unsupported shape; refusing to start with inherited tools.');
    const configured = servers.filter((entry) => entry && typeof entry === 'object' && (entry as { enabled?: unknown }).enabled !== false);
    const names = configured.map((entry) => (entry as { name?: unknown }).name);
    if (names.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name))) {
      throw new Error('A configured MCP server name cannot be safely isolated.');
    }
    return [...new Set(names as string[])];
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error('Codex App Server is offline.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Could not write to Codex App Server.'));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.child || this.child.killed) throw new Error('Codex App Server is offline.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  respond(id: string | number, result: unknown): void {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  respondError(id: string | number, code: number, message: string): void {
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  private receive(line: string): void {
    if (line.length > 20_000_000) {
      this.emit('protocolError', new Error('Codex App Server emitted an oversized protocol line.'));
      return;
    }
    let message: JsonRpc;
    try { message = JSON.parse(line) as JsonRpc; }
    catch { this.emit('protocolError', new Error('Codex App Server emitted invalid JSONL.')); return; }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CodexAppServerError(message.error.message || `App Server error ${message.error.code ?? 'unknown'}`, message.error.code, message.error.data));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) this.emit('serverRequest', message);
    else if (message.method) this.emit('notification', message);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failAll(new CodexAppServerExitedError('Codex App Server was stopped.'));
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      timeout.unref();
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
}
