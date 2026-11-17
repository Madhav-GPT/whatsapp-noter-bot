import { access, chmod, lstat, mkdir, realpath, readlink, symlink, writeFile } from 'node:fs/promises';
import { accessSync, constants, realpathSync } from 'node:fs';
import { dirname, delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function tomlString(value: string): string { return JSON.stringify(value); }

function permissionsConfig(executablePaths: string[]): string {
  const executableRules = [...new Set(executablePaths)].map((path) => `${tomlString(path)} = "read"`).join('\n');
  return `default_permissions = "gateway-readonly"
approval_policy = "on-request"
web_search = "live"

[features]
apps = false
hooks = false
memories = false
multi_agent = false
remote_plugin = false
shell_snapshot = false

[permissions.gateway-readonly.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
${executableRules}

[permissions.gateway-readonly.filesystem.":workspace_roots"]
"." = "read"

[permissions.gateway-readonly.network]
enabled = false

[permissions.gateway-project]
extends = ":workspace"

[permissions.gateway-project.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
${executableRules}

[permissions.gateway-project.filesystem.":workspace_roots"]
"." = "write"

[permissions.gateway-project.network]
enabled = false
`;
}

export async function prepareGatewayCodexHome(dataDir: string, projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex')): Promise<string> {
  const root = await realpath(projectRoot);
  const home = join(dataDir, 'codex-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);

  const sourceAuth = join(sourceHome, 'auth.json');
  const targetAuth = join(home, 'auth.json');
  const resolvedSource = await realpath(sourceAuth).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (resolvedSource) {
    const authInfo = await lstat(resolvedSource);
    if (!authInfo.isFile() || (authInfo.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && authInfo.uid !== process.getuid())) {
      throw new Error('The local Codex auth file must be a regular owner-only file.');
    }
  }
  try {
    const targetInfo = await lstat(targetAuth);
    if (targetInfo.isSymbolicLink()) {
      if (!resolvedSource || await realpath(targetAuth) !== resolvedSource) throw new Error('The isolated Codex auth link is invalid.');
    } else if (!targetInfo.isFile() || (targetInfo.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && targetInfo.uid !== process.getuid())) {
      throw new Error('The isolated Codex auth file must be a regular owner-only file.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (resolvedSource) await symlink(resolvedSource, targetAuth);
    // With no source auth, leave the isolated home ready for a separate local login.
  }

  const node = process.execPath;
  const codexExecutable = resolveCodexExecutable(process.env.CODEX_BIN || 'codex');
  const codexExecutablePath = await realpath(codexExecutable);
  const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const mcpEntry = join(root, 'src', 'mcp.ts');
  await Promise.all([access(node, constants.X_OK), access(tsx, constants.R_OK), access(mcpEntry, constants.R_OK)]);
  const mcpEnvironment: Record<string, string> = { REEL_TO_CODEX_DATA_DIR: dataDir };
  if (process.env.REEL_TO_CODEX_DATABASE) mcpEnvironment.REEL_TO_CODEX_DATABASE = process.env.REEL_TO_CODEX_DATABASE;
  const config = `${permissionsConfig([codexExecutable, codexExecutablePath])}
[mcp_servers.reel-to-codex]
command = ${tomlString(node)}
args = [${tomlString(tsx)}, ${tomlString(mcpEntry)}]
env = { ${Object.entries(mcpEnvironment).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }
enabled = true
`;
  const configPath = join(home, 'config.toml');
  try {
    const existing = await lstat(configPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('The isolated Codex config must be a regular local file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(configPath, config, { encoding: 'utf8', mode: 0o600 });
  await chmod(configPath, 0o600);
  return home;
}

export function isolatedCodexEnvironment(home: string, executable: string): NodeJS.ProcessEnv {
  const standardPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const path = [...new Set([dirname(executable), dirname(process.execPath), ...standardPath])].join(delimiter);
  const environment: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home, PATH: path };
  for (const key of ['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEM_VERSION_COMPAT']) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export function resolveCodexExecutable(requested = 'codex', searchPath = process.env.PATH || ''): string {
  if (requested.includes('/') || requested.includes('\\')) return realpathSync(resolve(requested));
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, requested);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch { /* try the next PATH entry */ }
  }
  throw new Error('Codex CLI was not found on PATH. Install or expose the local Codex CLI, then restart the gateway.');
}

export async function gatewayAuthPath(home: string): Promise<string | null> {
  try {
    const path = join(home, 'auth.json');
    const info = await lstat(path);
    if (info.isSymbolicLink()) return await realpath(path);
    if (info.isFile()) return path;
    return null;
  } catch { return null; }
}

export async function gatewayAuthLinkTarget(home: string): Promise<string | null> {
  try { return await readlink(join(home, 'auth.json')); }
  catch { return null; }
}
