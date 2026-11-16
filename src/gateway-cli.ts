import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { openLibrary } from './library.js';
import { DATA_DIR } from './paths.js';

const [command = 'inbox', ...args] = process.argv.slice(2);
const library = await openLibrary();

try {
  if (command === 'inbox') {
    const tasks = library.listTasks(50);
    process.stdout.write(`Gateway ${library.isPaused() ? 'paused' : 'enabled'} · ${tasks.length} recent tasks\n\n`);
    for (const task of tasks) {
      process.stdout.write(`${task.id.slice(0, 8)}  ${task.status.padEnd(16)} ${task.intent}\n`);
      process.stdout.write(`  ${task.requestText.replaceAll('\n', ' ').slice(0, 240)}\n`);
      if (task.result) process.stdout.write(`  Result: ${task.result.slice(0, 600).replaceAll('\n', ' ')}${task.result.length > 600 ? '…' : ''}\n`);
      if (task.error) process.stdout.write(`  Error: ${task.error}\n`);
    }
    const approvals = library.pendingApprovals() as Array<{ code: string; taskId: string; method: string; details: string }>;
    if (approvals.length) {
      process.stdout.write('\nPending Codex approval requests (none are approved automatically):\n');
      for (const approval of approvals) process.stdout.write(`${approval.code}  task ${approval.taskId.slice(0, 8)}  ${approval.method}\n  ${approval.details.slice(0, 1200)}\n`);
    }
    const outbox = library.getOutbox(20) as Array<{ taskId: string | null; body: string; deliveryState: string; createdAt: string }>;
    process.stdout.write('\nLocal result inbox:\n');
    for (const item of outbox) process.stdout.write(`[${item.deliveryState}] ${item.taskId?.slice(0, 8) ?? 'gateway'} ${item.createdAt}\n${item.body.slice(0, 500)}${item.body.length > 500 ? '…' : ''}\n\n`);
  } else if (command === 'status') {
    const tasks = library.listTasks(100);
    const counts = tasks.reduce<Record<string, number>>((result, task) => { result[task.status] = (result[task.status] ?? 0) + 1; return result; }, {});
    process.stdout.write(JSON.stringify({ paused: library.isPaused(), counts, pendingApprovals: (library.pendingApprovals() as unknown[]).length }, null, 2) + '\n');
  } else if (command === 'pause') {
    library.setPaused(true);
    process.stdout.write('Gateway paused. Incoming messages remain queued; active Codex task can finish.\n');
  } else if (command === 'resume') {
    if (args[0]) {
      if (!library.resumeTask(args[0])) throw new Error('Task is not in needs_resume state or the ID is ambiguous.');
      process.stdout.write(`Task ${args[0]} queued for recovery.\n`);
    } else {
      library.setPaused(false);
      process.stdout.write('Gateway resumed.\n');
    }
  } else if (command === 'approve' || command === 'deny') {
    const code = args[0];
    if (!code) throw new Error(`Usage: npm run gateway:ctl -- ${command} <approval-code>`);
    if (!library.resolveApproval(code, command === 'approve')) throw new Error('Approval code not found, expired, or already resolved.');
    process.stdout.write(`${command === 'approve' ? 'Approved' : 'Denied'} ${code}.\n`);
  } else if (command === 'approve-task') {
    const id = args[0];
    if (!id || !library.approveProjectTask(id)) throw new Error('Project task is not waiting for approval or the ID is ambiguous.');
    process.stdout.write(`Read-only project task ${id} approved and queued.\n`);
  } else if (command === 'outbound-test') {
    const id = library.createOutboundTest();
    process.stdout.write(`Queued one harmless outbound test (${id.slice(0, 8)}). It sends only if the extension is open on the configured self-chat.\n`);
  } else if (command === 'project' && args[0] === 'add') {
    const [, alias, requestedPath] = args;
    if (!alias || !requestedPath || !/^[a-z][a-z0-9_-]{0,30}$/.test(alias)) throw new Error('Usage: npm run gateway:ctl -- project add <alias> <directory>');
    const canonical = await realpath(resolve(requestedPath));
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error('Project path must be a directory.');
    const home = await realpath(homedir());
    const relativePath = relative(home, canonical);
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('Project must be a subdirectory of your home folder.');
    if (/(^|\/)(\.ssh|\.codex|\.gnupg|Library\/Keychains)(\/|$)/i.test(relativePath)) throw new Error('This private configuration directory cannot be registered as a project.');
    const dataDir = await realpath(DATA_DIR).catch(() => resolve(DATA_DIR));
    if (canonical === dataDir || canonical.startsWith(`${dataDir}/`)) throw new Error('Gateway data storage cannot be registered as a project.');
    library.addProject(alias, canonical);
    process.stdout.write(`Registered ${alias} for read-only Codex access.\n`);
  } else if (command === 'project' && args[0] === 'list') {
    process.stdout.write(JSON.stringify(library.listProjects(), null, 2) + '\n');
  } else if (command === 'projects') {
    process.stdout.write(JSON.stringify(library.listProjects(), null, 2) + '\n');
  } else {
    throw new Error('Commands: inbox, status, pause, resume [task-id], approve <code>, deny <code>, approve-task <task-id>, outbound-test, project add|list.');
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Gateway command failed.'}\n`);
  process.exitCode = 1;
} finally {
  library.close();
}
