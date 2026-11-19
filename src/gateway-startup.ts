import { chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, SELF_CHAT_TITLE } from './paths.js';
import { resolveCodexExecutable } from './codex-home.js';

const GATEWAY_LABEL = 'com.madhav.reeltocodex.gateway';
const WHATSAPP_LABEL = 'com.madhav.reeltocodex.whatsapp';
const home = homedir();
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const domain = uid === null ? null : `gui/${uid}`;
const launchAgents = join(home, 'Library', 'LaunchAgents');
const logs = join(home, 'Library', 'Logs', 'ReelToCodex');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serviceEntry = join(repoRoot, 'src', 'service.ts');
const tsxEntry = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const nodeExecutable = process.execPath;
const codexExecutable = resolveCodexExecutable(process.env.CODEX_BIN || 'codex');
const launchPath = [...new Set([
  dirname(nodeExecutable),
  dirname(codexExecutable),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
])].join(':');

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function stringElement(value: string): string { return `<string>${xml(value)}</string>`; }

function plist(label: string, args: string[], extra: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>${stringElement(label)}\n  <key>ProgramArguments</key><array>${args.map(stringElement).join('')}</array>\n${extra}\n</dict>\n</plist>\n`;
}

function launchctl(args: string[], allowFailure = false): string | null {
  if (!domain) throw new Error('Per-user automatic startup is only supported on macOS.');
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 1_000_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} failed`).trim());
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function agentPath(label: string): string { return join(launchAgents, `${label}.plist`); }

async function writeAgent(label: string, content: string): Promise<void> {
  const path = agentPath(label);
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || (typeof process.getuid === 'function' && existing.uid !== process.getuid())) {
      throw new Error(`Refusing to replace an unexpected startup file at ${path}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function install(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Automatic startup is currently supported on macOS only.');
  if (!domain) throw new Error('Could not identify the current macOS user session.');
  await Promise.all([mkdir(launchAgents, { recursive: true, mode: 0o700 }), mkdir(logs, { recursive: true, mode: 0o700 })]);
  const logInfo = await lstat(logs);
  if (!logInfo.isDirectory() || logInfo.isSymbolicLink() || (typeof process.getuid === 'function' && logInfo.uid !== process.getuid())) {
    throw new Error(`Refusing to write gateway logs to an unexpected directory at ${logs}.`);
  }
  await chmod(logs, 0o700);
  for (const name of ['gateway.log', 'gateway-error.log', 'whatsapp-open.log', 'whatsapp-open-error.log']) {
    const path = join(logs, name);
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink() || (typeof process.getuid === 'function' && existing.uid !== process.getuid())) {
        throw new Error(`Refusing to write an unexpected log file at ${path}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(path, '', { encoding: 'utf8', mode: 0o600, flag: 'a' });
    await chmod(path, 0o600);
  }

  const environment: Record<string, string> = {
    HOME: home,
    USER: process.env.USER || basename(home),
    LOGNAME: process.env.LOGNAME || basename(home),
    PATH: launchPath,
    CODEX_BIN: codexExecutable,
    REEL_TO_CODEX_DATA_DIR: DATA_DIR,
  };
  if (process.env.LANG) environment.LANG = process.env.LANG;
  const envXml = Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key>${stringElement(value)}`).join('\n');
  const gateway = plist(GATEWAY_LABEL, [nodeExecutable, tsxEntry, serviceEntry], `  <key>WorkingDirectory</key>${stringElement(repoRoot)}\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>30</integer>\n  <key>ProcessType</key>${stringElement('Background')}\n  <key>EnvironmentVariables</key><dict>\n${envXml}\n  </dict>\n  <key>StandardOutPath</key>${stringElement(join(logs, 'gateway.log'))}\n  <key>StandardErrorPath</key>${stringElement(join(logs, 'gateway-error.log'))}`);
  const browser = plist(WHATSAPP_LABEL, ['/usr/bin/open', '-a', 'Google Chrome', 'https://web.whatsapp.com/'], `  <key>RunAtLoad</key><true/>\n  <key>StandardOutPath</key>${stringElement(join(logs, 'whatsapp-open.log'))}\n  <key>StandardErrorPath</key>${stringElement(join(logs, 'whatsapp-open-error.log'))}`);

  await writeAgent(GATEWAY_LABEL, gateway);
  await writeAgent(WHATSAPP_LABEL, browser);
  for (const label of [GATEWAY_LABEL, WHATSAPP_LABEL]) {
    const path = agentPath(label);
    launchctl(['bootout', domain, path], true);
    launchctl(['enable', `${domain}/${label}`]);
    launchctl(['bootstrap', domain, path]);
  }
  process.stdout.write(`Installed and started per-user background services.\nGateway logs: ${logs}/gateway-error.log\nWhatsApp Web opens in Chrome at login; collection runs only while “${SELF_CHAT_TITLE}” is selected.\n`);
}

async function stop(): Promise<void> {
  if (!domain) throw new Error('Could not identify the current macOS user session.');
  launchctl(['bootout', domain, agentPath(GATEWAY_LABEL)], true);
  process.stdout.write('Gateway service stopped. WhatsApp Web can remain open in Chrome.\n');
}

async function start(): Promise<void> {
  if (!domain) throw new Error('Could not identify the current macOS user session.');
  const path = agentPath(GATEWAY_LABEL);
  launchctl(['bootout', domain, path], true);
  launchctl(['enable', `${domain}/${GATEWAY_LABEL}`]);
  launchctl(['bootstrap', domain, path]);
  process.stdout.write('Gateway service started.\n');
}

async function status(): Promise<void> {
  if (!domain) throw new Error('Could not identify the current macOS user session.');
  for (const [label, description] of [[GATEWAY_LABEL, 'Gateway'], [WHATSAPP_LABEL, 'WhatsApp Web at login']] as const) {
    const result = launchctl(['print', `${domain}/${label}`], true);
    const state = result === null ? 'not loaded' : label === WHATSAPP_LABEL
      ? 'installed (opens Chrome at login; this one-shot job exits after opening)'
      : result.trim().split('\n').slice(0, 6).join('\n');
    process.stdout.write(`${description}: ${state}\n`);
  }
}

async function uninstall(): Promise<void> {
  if (!domain) throw new Error('Could not identify the current macOS user session.');
  for (const label of [GATEWAY_LABEL, WHATSAPP_LABEL]) {
    launchctl(['bootout', domain, agentPath(label)], true);
    launchctl(['disable', `${domain}/${label}`], true);
    await unlink(agentPath(label)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  process.stdout.write('Automatic startup removed. Your project, database, and Codex sign-in are unchanged.\n');
}

const action = process.argv[2] ?? 'status';
try {
  if (action === 'install') await install();
  else if (action === 'start') await start();
  else if (action === 'stop') await stop();
  else if (action === 'status') await status();
  else if (action === 'uninstall') await uninstall();
  else throw new Error('Usage: npm run gateway:startup -- install|start|stop|status|uninstall');
} catch (error) {
  process.stderr.write(`Automatic startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}
