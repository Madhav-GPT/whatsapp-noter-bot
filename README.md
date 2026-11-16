# WhatsApp Noter Bot

A local-first WhatsApp Message Yourself gateway to the authenticated Codex App Server. It keeps the existing Reel library, SQLite database, and read-only MCP tools, and adds durable tasks, persistent Codex threads, a task controller, and a local result inbox.

## How it works

The Chrome extension observes only newly visible messages while the exact configured Message Yourself chat is selected. It sends hashed WhatsApp message IDs and message text to a loopback collector at `127.0.0.1`. The collector accepts the pinned Chrome extension origin and a private bearer token. It is not exposed on the network.

Instagram Reel links continue to enter the Reel library. Other links and standalone text become durable Codex tasks instead of being discarded. Codex runs through the installed `codex app-server` using the local ChatGPT/Codex sign-in. Tasks use persistent App Server threads; a clear recent follow-up continues the one matching thread, while `/continue <task-id> ...` targets a thread directly.

General research uses Codex's read-only sandbox. A registered project task waits for your explicit approval before Codex gets write access limited to that project's directory; project tasks have no network access. Codex permission requests remain pending until you explicitly approve or deny them. No permission request is auto-approved.

The gateway disables configured local MCP servers other than its read-only `reel-to-codex` knowledge server, and disables installed Codex plugins for each turn. The installed App Server also exposes a host-provided CUA MCP whose transport rejects a per-process disable override. Gateway instructions prohibit computer-control and browser-automation calls; for a hard tool boundary, disable that CUA MCP in Codex before starting the gateway.

## Setup

Requirements: macOS, Node.js 22 or later, npm, Chrome, and a logged-in Codex CLI (`codex login`).

```sh
npm ci
npm run setup -- --self-chat-title "Your Name (You)"
```

Replace the example with the exact self-chat title shown in WhatsApp Web. Setup writes that value, a random collector token, and the ignored `extension/config.js` under `~/Library/Application Support/ReelToCodex`. These are owner-only local files and are excluded from Git.

Load or reload this project's `extension` folder from `chrome://extensions` with Developer mode enabled. Keep WhatsApp Web open and select the configured Message Yourself chat. The extension takes a baseline first; it does not import old messages.

Start the full local service in a terminal and leave it running:

```sh
npm run gateway
```

This starts the loopback collector and Codex task worker together. Stop it with `Ctrl+C`. `npm run collector` starts the collector alone when you want capture without task execution.

## Send requests and control tasks

Send a new URL or request in Message Yourself. For example:

```text
https://example.com
Research this website and prepare a structured technical report.
```

The task is queued, run by Codex, and saved in SQLite. The full result is available locally even when WhatsApp sending is disabled:

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

Outbound sending is disabled until its one-message test passes. Results remain in the local inbox. The extension's sender is constrained to the exact configured self-chat, requires a recognized outgoing-message marker and an empty composer, sends at most one message per minute, records the sent message ID hash, and filters `Codex:` replies to prevent loops. Ambiguous or failed sends are not retried automatically.

After the updated extension is loaded and the configured self-chat is selected, the one-shot test can be queued with:

```sh
npm run gateway:ctl -- outbound-test
```

That command sends one harmless test message only if the extension can verify the exact chat and WhatsApp page state. A successful test enables concise task and status replies. The full report stays in the local task record. The browser automation uses WhatsApp Web's page structure, which can change; if the send cannot be verified, it is marked failed and results continue to appear in the local inbox.

**The updated extension and outbound send have not yet been live-tested in this Chrome session.** Reloading the extension is required after code changes. No message has been sent by this implementation.

## Codex MCP

The MCP server remains a separate, read-only interface for the local knowledge library. It now exposes ten tools, including task listing, task details, and report search. Start it with:

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
- Check collector state: `npm run status`.
- Check database integrity: `npm run db:check`.
- Automated checks: `npm test` and `npm run typecheck`.
- SQLite database: `~/Library/Application Support/ReelToCodex/knowledge.sqlite`.
- Collector token: `~/Library/Application Support/ReelToCodex/collector-token`.

The schema upgrades transactionally and keeps existing Reel, instruction, and findings data. A running task interrupted by a service restart is marked `needs_resume`; it is never silently replayed. Use `/resume <task-id>` after reviewing the local task status.

## Limits and privacy

- Chrome must be open, WhatsApp Web logged in, and the exact self-chat selected. Selecting another chat pauses observation before the message container is queried.
- Earlier chat history is not imported. If the visible cursor disappears, collection pauses until rebaseline.
- Website, Reel, and repository content are untrusted input. The gateway wraps source text as untrusted and never treats it as trusted system instructions.
- General gateway tasks do not edit files. An explicitly approved project task may edit files only inside its registered project directory; network access and software installation are disabled for that task. Consequential App Server permission requests remain blocked until you decide.
- A gateway task is a separate Codex App Server thread; it does not take over an arbitrary conversation already open in Codex Desktop.
- Codex authentication and usage limits follow the locally signed-in Codex account. This project does not require a separate paid API key.
- The read-only sandbox protects local files; it does not constrain arbitrary actions exposed by MCP tools. Keep the CUA MCP disabled in Codex if you need a strict no-computer-control boundary.
- The Chrome extension can technically read WhatsApp Web content while enabled. Its code checks the configured title before reading message nodes, and the collector stores message content only for the configured self-chat.
- WhatsApp Web selectors are unofficial and may change. The sender fails closed if it cannot verify the composer, the configured chat, and a sent message.
