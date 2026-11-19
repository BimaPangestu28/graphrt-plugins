# whatsapp-web

**Status:** experimental · **ToS risk:** high. Unofficial WhatsApp Web automation of a personal account; only get_status ran live, no real send. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that drives **your personal WhatsApp** through
WhatsApp Web in a headless Chromium (Playwright). You scan a QR code once; after that, workflows and agents
can read chats and messages and send text and files in the background.

> **Warning:** automating a personal WhatsApp account breaks WhatsApp's Terms of Service. High volume or
> spam-like patterns can get your number **banned**. This plugin is for low-volume personal use: sends are
> rate limited by default and never retried. For business messaging use the official Cloud API
> (`whatsapp-api`). Selectors break when WhatsApp changes its web UI (see `lib/selectors.mjs`).
> See [docs/tos-audit.md](../docs/tos-audit.md#whatsapp-web).

## Features
- **Session:** `login` (node only) opens a visible window with the QR code. `get_status` reports
  `logged_in`, `needs_login` or `loading`.
- **Reading:**
  - `list_chats`: name, last message preview, time and unread count, with `unread_only`. A chat you marked
    as unread counts as 1 unread. Two chats with the same name are both listed.
  - `search_chats`: uses the WhatsApp search box. Returns chat and contact rows only (each with
    `kind`: `chat` or `contact`); section headers and message hits are left out.
  - `read_messages`: the last N messages of a chat. Each message has `id`, `from_me`, `sender`, `time`,
    `text` and delivery `status`.
- **Sending:**
  - `send_message`: sends to a phone number or to an existing chat by its exact name, then checks that the
    message appears as sent.
  - `send_file`: sends a photo, video or document from an allowed local directory or an https URL, with an
    optional caption.
- **Safety:**
  - A minimum interval between sends (30 s by default), and a daily cap that is stored in the profile directory.
    If the counter file is unreadable or corrupt, sending is blocked until you fix or delete it.
  - No automatic retries. Every send is logged to stderr.
  - Local files must be inside `WHATSAPP_WEB_ALLOWED_FILE_DIRS`. URL downloads are streamed and stop at 100 MB.
  - Before every send the plugin clears the message (or caption) box, types the text, and then checks that the
    box holds exactly that text. If it doesn't, or the run was cancelled, nothing is sent.
- **One browser per plugin process:**
  - It starts on the first operation and runs operations one at a time.
  - It closes after `WHATSAPP_WEB_IDLE_MINUTES` without use, and when graphrt stops the plugin. When graphrt
    closes the plugin's input, running operations get up to 60 s to finish and reply first; a signal
    (SIGTERM/SIGINT/SIGHUP) closes the browser at once.
  - A lock file in the profile keeps a second plugin process off the same profile. A lock left by a dead
    process is taken over.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- About 150 MB of disk for Chromium
- A phone with WhatsApp to scan the QR code (WhatsApp > Settings > Linked devices > Link a device)

## Installation
```bash
cd whatsapp-web
npm install
npx playwright install chromium
graphrt plugin install .
```
The plugin runs `node plugin.mjs` from its own directory, so `node_modules/` must sit next to it. If you install it
from git, run the `npm`/`npx` commands inside the installed copy (`~/.graphrt/plugins/whatsapp-web`).

## Quick Start
1. Log in once. A Chromium window opens with the QR code. Scan it within 3 minutes and the window closes by itself.
   Leave "Stay logged in on this browser" ticked. `timeout_seconds` (at most 240) covers loading WhatsApp Web and
   the scan together.
   ```yaml
   # login.yaml
   version: "1"
   name: whatsapp-login
   graph:
     nodes:
       - { id: start, type: start }
       - { id: login, type: whatsapp-web.login, timeout_seconds: 180 }
       - { id: answer, type: answer, answer: "{{#login.data.status#}}" }
     edges:
       - { source: start, target: login }
       - { source: login, target: answer }
   ```
   ```bash
   graphrt run login.yaml --plugins .
   ```
2. Check the session (headless from now on):
   ```bash
   graphrt run whatsapp-web/example.yaml --plugins .
   # WhatsApp Web: logged_in (Ready.) Sends today: 0/50
   ```

## Usage
```yaml
- { id: unread, type: whatsapp-web.list_chats, unread_only: true, limit: 10 }
- { id: history, type: whatsapp-web.read_messages, chat_name: "Ibu", limit: 20 }
- { id: reply, type: whatsapp-web.send_message, phone: "+62 812 3456 789", text: "On my way" }
- { id: photo, type: whatsapp-web.send_file, chat_name: "Family", file: "https://example.com/photo.jpg", caption: "Look!" }
```
- **Choosing the chat:** pass either `phone` or `chat_name`.
  - `phone` must start with `+` or `00` and the country code, for example `+62 812 3456 789` or
    `0062 812 3456 789`. Spaces, dashes and parentheses are ignored. A national number such as `0812 3456 789`,
    or digits without `+`, is refused, because it could be read with the wrong country code. `phone` works for
    numbers that are not in your chat list.
  - `chat_name` is the exact name shown in WhatsApp. If two chats have that name, the plugin refuses
    (`invalid_input`) and asks for `phone`.
- **Wrong chat protection:**
  - With `chat_name`, the plugin opens the chat and checks the conversation header before it types anything.
  - With `phone`, it checks that the messages on screen belong to that number. If they belong to another chat,
    it stops before typing.
- **Send confirmation:** a send counts as done only when a new outgoing message with the same text (or caption,
  or file name) appears in the chat.
- **Read receipts:** opening a chat to read or send marks it as read on your phone.
- **Message times:** `time` keeps WhatsApp's own format (for example `10:42, 18/11/2026`), which depends on
  your locale.
- **Agent tools:** every operation except `login` is also a tool (`whatsapp-web/send_message` and so on).
  Give agents the send tools only when you mean to.

## Configuration
| Env var | Default | Description |
|---------|---------|-------------|
| `WHATSAPP_WEB_PROFILE_DIR` | `~/.graphrt/whatsapp-web/profile` | Chromium profile holding the WhatsApp session, the send counters (`graphrt-send-state.json`) and a lock file (`graphrt-whatsapp-web.lock`) |
| `WHATSAPP_WEB_IDLE_MINUTES` | `15` | Close the background browser after this many idle minutes |
| `WHATSAPP_WEB_MIN_SEND_INTERVAL_SECONDS` | `30` | Minimum gap between two sends. Bursts of sends from a personal account risk a ban, so keep it high. Waits of up to 60 s happen inline; a longer wait fails with `rate_limited` |
| `WHATSAPP_WEB_DAILY_SEND_LIMIT` | `50` | Sends per local calendar day. `0` disables sending |
| `WHATSAPP_WEB_ALLOWED_FILE_DIRS` | *(none)* | Comma-separated directories `send_file` may read local files from. When it is unset, only https URLs work |

Treat the profile directory like a password: anyone with a copy of it can read and send your WhatsApp
messages. To log out, unlink the device on your phone, or delete the directory.

## Errors
| Kind | When |
|------|------|
| `auth_error` | The QR screen is showing. Run the `login` node. Operations fail fast and never wait for a scan |
| `not_found` | No chat with that exact name, the number is not on WhatsApp, or the file or URL is missing |
| `rate_limited` | The daily cap was reached (`retryable: false`, resets at local midnight), the send interval is longer than 60 s, or the send counter file (`graphrt-send-state.json`) is unreadable or corrupt (`retryable: false`: fix or delete the file to reset) |
| `browser_error` | A UI step failed or timed out. The message names the step, e.g. ``step `open chat` failed``. It is also used when the phone chat belongs to another number, or when the text box doesn't hold exactly the intended text (``step `check text before sending` ``). Nothing is sent in those cases |
| `network_error` | Downloading a `send_file` URL failed or timed out |
| `setup_required` | Playwright or Chromium is not installed |
| `invalid_input` | Bad arguments or env values, such as a phone number without `+`/`00` and a country code, both `phone` and `chat_name`, a `chat_name` shared by several chats, or a file outside the allowed directories |
| `cancelled` | The run was cancelled. The page is closed and the next operation reopens it. A cancel that arrives before Enter is pressed (or the send button is clicked) sends nothing |

**Uncertain sends:** a send that fails after Enter was pressed (``step `confirm sent` failed``) might still
have been delivered. Check WhatsApp before you send again.

## Limitations
- The plugin's profile is its own linked device, so WhatsApp Web in your normal browser keeps working.
  Two graphrt processes can't share one profile directory at the same time, though. The second one fails with
  `browser_error` ("profile is in use").
- WhatsApp unlinks devices that stay offline for a long time (about 14 days). After that, run `login` again.
- A crashed WhatsApp Web tab is replaced with a fresh one on the next operation.
- The phone-chat check reads the chat id from each message. If WhatsApp shows a chat under a privacy id
  (`...@lid`) instead of the phone number, the check can't confirm the number, so the plugin refuses to use the
  chat. Use `chat_name` for that chat instead.
- The plugin does not listen for incoming messages. Poll `list_chats` with `unread_only` from a workflow.
- `list_chats` reads the chat list from the top by scrolling, so it has no cursor and `next_cursor` is always
  null.
- The selectors were checked live against the login screen only. The logged-in selectors follow the
  WhatsApp Web markup as known in late 2026 and may need updating in `lib/selectors.mjs`.

## Development
```bash
npm test   # fakes only: no browser starts, nothing is sent
```
`lib/selectors.mjs` holds the selectors. `lib/dom-probes.mjs` holds the functions that run in the page.
`lib/parse.mjs` holds the pure parsers, which the tests feed with sample DOM data.

## License
Apache-2.0
