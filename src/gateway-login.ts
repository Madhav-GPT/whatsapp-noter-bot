import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR } from './paths.js';
import { isolatedCodexEnvironment, prepareGatewayCodexHome, resolveCodexExecutable } from './codex-home.js';

const executable = resolveCodexExecutable(process.env.CODEX_BIN || 'codex');
const home = await prepareGatewayCodexHome(DATA_DIR);
const env = isolatedCodexEnvironment(home, executable);
const status = spawnSync(executable, ['login', 'status'], { encoding: 'utf8', timeout: 10_000, env });
if (!status.error && status.status === 0 && /logged in/i.test(`${status.stdout ?? ''}\n${status.stderr ?? ''}`)) {
  process.stdout.write('Gateway Codex home is signed in.\n');
  process.exit(0);
}

const child = spawn(executable, ['login'], { stdio: 'inherit', env });
child.once('error', (error) => {
  process.stderr.write(`Could not start local Codex sign-in: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code) => process.exit(code ?? 1));
