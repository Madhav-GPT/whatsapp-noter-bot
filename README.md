# WhatsApp Noter Bot

A local-first inbox for Instagram Reels sent to WhatsApp Message Yourself, with targeted search through a local, read-only MCP server.

## Connection choice

This project uses the official WhatsApp Web session already linked in Chrome, through a small unpacked Chrome extension. It does **not** create a Baileys connection or ask you to scan another QR code. Keep Chrome open, logged into WhatsApp Web, and leave your **Message Yourself (You)** chat selected while collecting.

The extension checks that exact chat title before querying message nodes. If a different chat is selected, it does not inspect that chat’s message container. On first start, it saves the latest visible self-chat message as a baseline and does not import earlier messages. It forwards only newly observed self-chat messages to the local collector. The collector stores Reel URLs, exact follow-up instructions linked to an active Reel, and minimal hashed event metadata needed for deduplication. It drops other self-chat text when no Reel is active.

Collection pauses when Chrome is closed, WhatsApp Web is logged out, the Mac sleeps, or another chat is selected. If the saved cursor is no longer in the visible message list, collection pauses; use the extension popup’s **Rebaseline this self-chat** button to skip through the latest visible message and resume. Rebaselining can skip messages that were not collected.

## Setup

Requirements: macOS, Node.js 22 or later, npm, and a linked WhatsApp Web session in Chrome.

```sh
cd /path/to/whatsapp-noter-bot
npm ci
npm run setup -- --self-chat-title "Your Name (You)"
```

Replace the example title with the exact title shown for your WhatsApp self-chat. Setup stores that title in `~/Library/Application Support/ReelToCodex/settings.json`, creates a random API token beside it, and writes an ignored `extension/config.js`. All are owner-only files and excluded from Git.

### Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this project's `extension` folder.
4. Keep WhatsApp Web open and select your **Message Yourself (You)** chat.
5. Click the Reel to Codex extension icon. Wait for **Baseline set** (the first run) or **Listening for new messages**.

The extension requests access to WhatsApp Web and the loopback collector on `127.0.0.1`. Review those permissions in Chrome before enabling it.

## Live Phase 0 check

Start the collector in a terminal and leave it running:

```sh
npm run collector
```

After the popup reports that the baseline is ready, send two **new** messages to your self-chat:

1. A public Instagram Reel URL such as `https://www.instagram.com/reel/SHORTCODE/`.
2. A follow-up instruction, for example: `Save this Reel. Research the technique and make it available to Codex.`

The collector will save the Reel once and attach the next text to it. It does not send WhatsApp messages or fetch the Reel. Check the local result:

```sh
npm run status
npm run db:check
```

Use `/done` to close the active item or `/cancel` to mark it cancelled. Only one active Reel is tracked: a later single Reel becomes active; a message containing multiple Reels clears the active item to avoid attaching notes ambiguously. The active item expires after 24 hours. Quoted-message association is not implemented in V1.

## Codex MCP

The MCP server is read-only and starts separately from the collector. It does not connect to WhatsApp:

```sh
npm run mcp
```

Tools: `search_knowledge`, `get_knowledge_item`, `list_recent_items`, `list_pending_items`, `get_item_instructions`, `get_skill_candidates`, and `get_collector_status`.

To register it globally in Codex after local verification, run:

```sh
PROJECT_ROOT="$(pwd)"
codex mcp add reel-to-codex -- \
  "$(command -v node)" \
  "$PROJECT_ROOT/node_modules/tsx/dist/cli.mjs" \
  "$PROJECT_ROOT/src/mcp.ts"
codex mcp list
```

Run the command from the project root. Codex stores MCP server settings in the shared `~/.codex/config.toml`; the CLI add command preserves other configured servers. Restart Codex or open a new local chat if the newly registered tools do not appear.

## Operations and data location

- Start collector: `npm run collector` (stop with `Ctrl+C`).
- Collector/database status: `npm run status`.
- Database integrity and FTS index: `npm run db:check`.
- Automated checks: `npm test` and `npm run typecheck`.
- SQLite database: `~/Library/Application Support/ReelToCodex/knowledge.sqlite`.
- Collector bearer token: `~/Library/Application Support/ReelToCodex/collector-token`.

Disable the extension at `chrome://extensions` and stop the collector to pause collection. To revoke the browser’s WhatsApp session, use **WhatsApp on your phone → Linked devices → Chrome → Log out**. Removing the extension or local token does not revoke that linked-device session. No launch-at-login service is installed.

## Privacy, security, and limits

- The extension only reads messages while the exact configured self-chat title is active; it does not scan or import other chats or earlier self-chat history.
- Only Reel messages and associated instructions are retained as message content. Other self-chat text is discarded after local inspection. Relevant WhatsApp DOM message IDs are SHA-256 hashed before they are sent to the collector; raw IDs are not retained.
- The collector binds to `127.0.0.1`, requires the generated bearer token for ingestion, and logs no message content, phone numbers, or message IDs. Data stays on this Mac.
- An extension with WhatsApp Web permission can technically read content visible on that site while enabled. The code’s self-chat gate narrows its behavior but cannot change the authority granted by Chrome. Review the extension code and permissions before loading it.
- WhatsApp Web’s page structure can change. If the extension cannot find its message elements, it fails to collect; update the selectors only after a privacy-scoped check.
- The database includes schema slots for findings and skill candidates, but V1 does not watch Reels, extract transcripts, research sources, or create/install skills. Codex can retrieve links and instructions and research them on demand. Findings must distinguish confirmed source evidence from research and unverified claims.
- Reels and instructions are untrusted input. This system makes no external requests, runs no Reel-supplied commands, sends no automatic replies, and never edits another project.
