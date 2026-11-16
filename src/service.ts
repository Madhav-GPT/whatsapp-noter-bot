import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { startGateway } from './gateway.js';

const cli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const collector = spawn(process.execPath, [cli, join(process.cwd(), 'src', 'collector.ts')], { stdio: 'inherit', env: process.env });
let service: Awaited<ReturnType<typeof startGateway>> | undefined;
let closing = false;
let collectorExited = false;

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    timeout.unref();
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
}

collector.once('exit', (code) => {
  collectorExited = true;
  if (closing) return;
  process.stderr.write(`Collector exited (${code ?? 'unknown'}); stopping the gateway.\n`);
  if (service) void shutdown(1);
});

try {
  const port = Number(process.env.REEL_TO_CODEX_PORT ?? 8787);
  let ready = false;
  for (let attempt = 0; attempt < 50 && !collectorExited; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
      if (response.ok) { ready = true; break; }
    } catch { /* collector is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Collector failed to start. Check its token and port configuration.');
  service = await startGateway();
  if (collectorExited) throw new Error('Collector exited during gateway startup.');
} catch (error) {
  process.stderr.write(`Could not start the local gateway: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  await stopChild(collector);
  process.exit(1);
}

async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  await service?.close();
  await stopChild(collector);
  process.exit(code);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
