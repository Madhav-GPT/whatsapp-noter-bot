# WhatsApp Noter Bot

A local-first WhatsApp Message Yourself gateway to the authenticated Codex App Server. It keeps the existing Reel library, SQLite database, and read-only MCP tools, and adds durable tasks, persistent Codex threads, a task controller, and a local result inbox.

## How it works

The Chrome extension observes only newly visible messages while the exact configured Message Yourself chat is selected. It sends hashed WhatsApp message IDs and message text to a loopback collector at `127.0.0.1`. The collector accepts the pinned Chrome extension origin and a private bearer token. It is not exposed on the network.

Instagram Reel links continue to enter the Reel library. Safe mode is the default: ordinary text and standalone links become searchable local notes. Use `/codex`, `/research`, `/repo`, `/continue`, or `/project` when you want Codex to run. `/mode agent` opts in to treating ordinary messages as Codex requests; `/mode safe` turns that behavior off. Tasks use persistent App Server threads; natural follow-ups attach only when one recent completed task is a clear match, while `/continue <task-id> ...` targets a thread directly.

General research uses Codex's read-only sandbox. A registered project task waits for your explicit approval before Codex gets write access limited to that project's directory; project tasks have no network access. File-change requests stay pending until you approve or deny them; requests to widen filesystem, network, root, or command policy are denied by the gateway. No permission escalation is auto-approved.

The gateway starts Codex in a separate configuration home containing only the read-only `reel-to-codex` MCP server. It disables plugins, Apps, remote plugins, hooks, memories, and multi-agent features; strips unrelated shell environment variables; disables shell network access; and selects a named filesystem permission profile for each task. It checks the App Server's effective MCP list for each task and pauses if an unexpected provider, including a host computer-use tool, appears. The gateway links the existing local Codex auth file when available; otherwise use `npm run gateway:login` once for the isolated home.

## Setup

Requirements: macOS, Node.js 22 or later, npm, Chrome, and the local Codex CLI.

```sh
npm ci
npm run setup -- --self-chat-title "Your Name (You)"
```

Replace the example with the exact self-chat title shown in WhatsApp Web. Setup writes that value, a random collector token, and the ignored `extension/config.js` under `~/Library/Application Support/ReelToCodex`. These are owner-only local files and are excluded from Git.

Load or reload this project's `extension` folder from `chrome://extensions` with Developer mode enabled. Keep WhatsApp Web open and select the configured Message Yourself chat. The extension takes a baseline first; it does not import old messages.

Sign in to the gateway's isolated Codex home when needed, then start the service:

```sh
npm run gateway:login
npm run gateway
```

If the existing local Codex sign-in is available, `gateway:login` detects it automatically. Otherwise it opens Codex's normal sign-in flow once for the isolated gateway home.

Start the full local service in a terminal and leave it running:

```sh
npm run gateway
```

This starts the loopback collector and Codex task worker together. Stop it with `Ctrl+C`. `npm run collector` starts the collector alone when you want capture without task execution.

## Send requests and control tasks

In safe mode, ordinary messages are saved as notes. Start Codex explicitly:

```text
/research Research this website and prepare a structured technical report: https://example.com
```

Other commands include `/codex <request>`, `/repo <request>`, `/project <alias> <request>`, and `/continue <task-id> <follow-up>`. To opt into ordinary conversational requests, send `/mode agent`; `/mode safe` returns to note-first behavior. The current mode appears in `/status` and the local inbox.

Tasks run through Codex App Server and are saved in SQLite. The full result is available locally even when WhatsApp sending is disabled:

```sh
npm run gateway:inbox
npm run gateway:ctl -- status
```

Supported WhatsApp commands:

- `/help` and `/status`
- `/pause` and `/resume` (pause or resume new task execution)
- `/stop <task-id>`
- `/resume <task-id>` to recover a task interrupted by a restart
- `/continue <task-id> <follow-up>`
- `/codex <request>`
- `/research <request>` and `/repo <request>`
- `/mode safe` or `/mode agent`
- `/approve <code>` and `/deny <code>` for a Codex permission prompt
- `/project <alias> <request>` for a registered local project
- `/done` and `/cancel` for the active Reel item

Natural-language follow-ups are attached to a previous thread only if there is exactly one completed recent task. Otherwise they start without mixing another task's context; use `/continue` when you want to name the target explicitly.

Register project directories locally before referencing them in WhatsApp. Paths must be inside your home folder and cannot point into private configuration directories:

```sh
npm run gateway:ctl -- project add demo "$PWD"
npm run gateway:ctl -- project list
```

A `/project` task waits until you explicitly approve its task ID. Approval allows Codex to make requested changes only inside that registered project directory. Project tasks cannot access the network, install software, change global settings, commit or push, or publish externally. Each continuation of a project task also requires approval. Codex approval codes and task state can be reviewed in `npm run gateway:inbox`; the local CLI supports `approve <code>`, `deny <code>`, and `approve-task <task-id>`.

## WhatsApp replies

Outbound sending is disabled until its one-message test passes. Results remain in the local inbox. The extension checks the exact configured self-chat and an initially empty editable composer, types before it looks for an enabled send button, then verifies a new outgoing message with a new WhatsApp identity. It sends at most one message per minute and filters `Codex:` replies to prevent loops. A failure before clicking is marked failed; after clicking, an unverified delivery is marked uncertain and is never retried automatically.

After the updated extension is loaded and the configured self-chat is selected, the one-shot test can be queued with:

```sh
npm run gateway:ctl -- outbound-test
```

After you explicitly choose to run that command, it queues one harmless test message. It can only be claimed while the extension is open on the exact configured self-chat. A successful verified delivery enables concise task and status replies. The full report stays in the local task record. WhatsApp Web's page structure can change; a send that cannot be verified is marked uncertain and results continue to appear in the local inbox.

**The updated extension and outbound send have not yet been live-tested in this Chrome session.** Reloading the extension is required after code changes. No message has been sent by this implementation.

## Codex MCP

The MCP server remains a separate, read-only interface for the local knowledge library. It exposes tools for Reel knowledge, saved notes, task listing, task details, and report search. Start it with:

```sh
npm run mcp
```

It does not read WhatsApp directly or run tasks. The gateway service owns task execution.

## Operations and data

- Start/stop the full gateway: `npm run gateway` / `Ctrl+C`.
- Start capture only: `npm run collector`.
- View task results and approvals: `npm run gateway:inbox`.
- Pause execution: `npm run gateway:ctl -- pause`.
- Inspect task totals: `npm run gateway:ctl -- status`.
- Change routing mode: `npm run gateway:ctl -- mode safe|agent`.
- Sign in to the isolated Codex home: `npm run gateway:login`.
- Check collector state: `npm run status`.
- Check database integrity: `npm run db:check`.
- Automated checks: `npm test` and `npm run typecheck`.
- SQLite database: `~/Library/Application Support/ReelToCodex/knowledge.sqlite`.
- Collector token: `~/Library/Application Support/ReelToCodex/collector-token`.

The schema upgrades transactionally and keeps existing Reel, instruction, and findings data. A running task interrupted by a service restart is marked `needs_resume`; it is never silently replayed. Use `/resume <task-id>` after reviewing the local task status.

## Limits and privacy

- Chrome must be open, WhatsApp Web logged in, and the exact self-chat selected. Closing Chrome or WhatsApp Web stops collection and reply delivery. Selecting another chat pauses observation before message nodes are queried and blocks outbound sends.
- If the Mac sleeps, the gateway and Chrome stop polling. After wake, collection continues only when the browser is open, WhatsApp Web is logged in, and the exact self-chat is selected. If the last visible cursor has disappeared, collection stays paused until you review the chat and choose Rebaseline.
- Earlier chat history is not imported. If the visible cursor disappears, collection pauses until rebaseline.
- Website, Reel, and repository content are untrusted input. The gateway wraps source text as untrusted and never treats it as trusted system instructions.
- Research tasks use a read-only named filesystem profile and have no shell network access; built-in Codex web research remains available. An explicitly approved project task may edit files only inside its registered project directory and also has no shell network access. Permission, network, root, and execution-policy widening requests are denied. File-change approval requests are shown only for paths verified inside the registered project.
- A gateway task is a separate Codex App Server thread; it does not take over an arbitrary conversation already open in Codex Desktop.
- Codex authentication and usage limits follow the locally signed-in Codex account. This project does not require a separate paid API key.
- Only the read-only local knowledge MCP is configured for the gateway. The App Server effective MCP inventory is checked before a turn; an unexpected provider blocks the task and pauses the gateway.
- The Chrome extension can technically read WhatsApp Web content while enabled. Its code checks the configured title before reading message nodes, and the collector stores message content only for the configured self-chat.
- WhatsApp Web selectors are unofficial and may change. The sender fails closed if it cannot verify the composer, the configured chat, and a sent message.
