import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

type JsonRpc = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

/** Minimal JSONL client for the supported local Codex App Server protocol. */
export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private disabledPluginIds: string[] = [];

  constructor(private readonly executable = process.env.CODEX_BIN || 'codex', private readonly configuredMcpNames?: string[]) { super(); }

  async start(): Promise<void> {
    if (this.child) return;
    const names = this.configuredMcpNames ?? this.readConfiguredMcpNames();
    // Codex 0.164 rejects a command-line override for the host-provided CUA transport.
    // Keep that transport under the user's existing Codex policy; disable other configured servers.
    const configArgs = names.filter((name) => name !== 'reel-to-codex' && name !== 'cua_repl')
      .flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
    const child = spawn(this.executable, ['app-server', ...configArgs, '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.receive(line));
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').slice(0, 2000);
      this.emit('stderr', line);
    });
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code, signal) => {
      this.failAll(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'}).`));
      this.child = null;
      this.emit('exit', { code, signal });
    });
    try {
      await this.request('initialize', {
        clientInfo: { name: 'whatsapp-noter-bot', title: 'WhatsApp to Codex Gateway', version: '0.2.0' },
        capabilities: { experimentalApi: false },
      });
      this.notify('initialized', {});
      const installed = await this.request('plugin/installed', {}, 10_000);
      const marketplaces = (installed as { marketplaces?: Array<{ plugins?: Array<{ id?: string; installed?: boolean; enabled?: boolean }> }> })?.marketplaces ?? [];
      this.disabledPluginIds = marketplaces.flatMap((marketplace) => marketplace.plugins ?? [])
        .filter((plugin) => plugin.installed && plugin.enabled && typeof plugin.id === 'string').map((plugin) => plugin.id!);
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  getDisabledPluginIds(): string[] { return [...this.disabledPluginIds]; }

  private readConfiguredMcpNames(): string[] {
    const result = spawnSync(this.executable, ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 2_000_000, env: process.env });
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
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
      if (message.error) pending.reject(new Error(message.error.message || `App Server error ${message.error.code ?? 'unknown'}`));
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
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      timeout.unref();
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
}
