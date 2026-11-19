# Personal Codex Gateway

A local-first personal assistant that receives requests in a private Telegram bot chat, stores them in SQLite, and runs approved work through the authenticated Codex App Server. Telegram's official Bot API is the message transport. WhatsApp is not paired or required.

## Architecture

```text
Telegram private bot chat
  ↕ HTTPS Bot API (long polling)
Local Telegram transport ── SQLite task queue ── Codex App Server
```

The Telegram worker uses `getUpdates` long polling, so the Mac needs no public inbound port. The worker accepts only a direct private chat from the paired Telegram account. It ignores groups, channels, other users, and bot messages. It downloads no media; text and captions are supported. Message updates are deduplicated in SQLite, and the Telegram update offset is saved locally after processing.

Telegram bot chats are not end-to-end encrypted. Telegram and the local bot backend can process messages sent to the bot; do not send passwords, recovery codes, or secrets. Bot API updates remain available for up to 24 hours, so a Mac that is off longer may miss messages. See [Telegram's Bot API](https://core.telegram.org/bots/api) and [bot security FAQ](https://telegram.org/faq?setln=en).

## First-time setup

1. In Telegram, message [@BotFather](https://t.me/BotFather), run `/newbot`, and keep the token private.
2. In a terminal in this project, run `npm run telegram:configure`. Paste the BotFather token at the hidden prompt. The command verifies it and stores it with owner-only file permissions under `~/Library/Application Support/ReelToCodex`.
3. Run `npm run telegram:pair`. Open the new bot's private chat, tap **Start**, and send the one-time `/pair <code>` printed in the terminal. Only that Telegram account is accepted afterward.
4. Check setup with `npm run telegram:status`.
5. Start the gateway with `npm run gateway` or install per-user macOS login startup with `npm run gateway:startup -- install`. Startup installation requires a configured and paired Telegram bot; it removes the old WhatsApp-to-Chrome opener and starts the Telegram gateway at login.

The token and paired account ID remain local. Never paste the BotFather token into a Codex conversation, issue, or commit.

## Use

Open the private bot chat and send messages there. It cannot read your Telegram Saved Messages or act as your personal Telegram account. Telegram bots cannot start a chat, so you must open the chat and send `/start` once.

Telegram pairing enables natural conversation by default: ordinary messages start read-only Codex tasks and follow-ups reuse the recent default conversation. A Reel link by itself is saved and acknowledged without starting an expensive task; text sent with the link starts a task. Send `/mode safe` to switch to note-only mode, or `/mode agent` to resume natural task handling.

Useful commands include:

- `/start`, `/help`, and `/status`
- `/pause` and `/resume`
- `/codex <request>`, `/research <request>`, and `/repo <request>`
- `/project <alias> <request>` for a locally registered project
- `/approve <code>` and `/deny <code>` for Codex permission requests
- `/continue <task-id> <follow-up>`, `/stop <task-id>`, `/done`, and `/cancel`

Register projects locally before using `/project`; each project task still requires explicit approval. Project paths must be under your home directory and cannot target private configuration folders.

## Replies and testing

Outbound replies stay local until a one-shot test succeeds. After the Telegram worker is running, run:

```sh
npm run gateway:ctl -- outbound-test
```

That queues one harmless test message for the selected transport. Once Telegram confirms delivery, concise task status and result replies can be sent automatically to the paired private chat. Each send is rate-limited; an uncertain delivery is never retried automatically. Full reports remain in the local task record and inbox.

Useful local commands:

```sh
npm run gateway:inbox
npm run gateway:ctl -- status
npm run gateway:ctl -- mode safe
npm run gateway:startup -- status|start|stop|uninstall
npm test
npm run typecheck
```

The read-only MCP server is separate: run `npm run mcp`. It exposes the local knowledge library and does not read Telegram directly or execute tasks.

## Operations and limits

- The gateway runs while the Mac is awake, logged in, and the service is running. It cannot process requests while the Mac is shut down or asleep.
- Telegram update delivery uses a durable offset. Ingested messages are deduplicated by a stable hash of Telegram chat and message IDs, including after restarts.
- The Bot API update queue is retained for up to 24 hours. Keep the Mac available for requests that need prompt handling.
- Gateway task data and the Telegram token are stored locally under `~/Library/Application Support/ReelToCodex`; private files use owner-only permissions.
- Website, Reel, and repository content are untrusted input. The gateway does not treat instructions embedded in those sources as trusted rules.
- Research tasks are read-only. Project tasks can write only inside a registered project, require approval, and run without network access.
- Codex authentication and usage limits follow the locally signed-in Codex account. No separate model API key is required.
