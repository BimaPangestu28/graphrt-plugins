# WhatsApp and computer-control plugins: design

Date: 2026-11-18 · Status: approved in conversation (the user picked all three and asked for autonomous execution)

## Intent
The user wants to drive their own WhatsApp and their Mac from graphrt workflows and agents:
- `whatsapp-web`: the user's **personal** WhatsApp, running quietly in the background through a headless browser.
- `whatsapp-api`: a **business** number through the official WhatsApp Business Cloud API.
- `computer-control`: control of desktop apps on macOS (including WhatsApp Desktop) when it's acceptable for the plugin to take keyboard and window focus.

## Key constraints found
- graphrt tool results reach the model as **text only** (`ToolOutput {text, data, is_error}`), so the agent can't "see" screenshots. `computer-control` therefore works from the macOS Accessibility tree, which is text, and screenshots are saved files for workflows.
- macOS UI automation needs an unlocked, logged-in GUI session. Typing needs the target app frontmost, so the plugin steals focus while it types. Accessibility and Screen Recording permissions must be granted to the process that runs graphrt.
- WhatsApp Web automation of a personal account breaks WhatsApp's ToS, and high volume or spam-like patterns can get the number banned. The plugin is built for low-volume personal use, with send rate limits on by default.
- WhatsApp Cloud API: the first message to someone must use an approved template, recipients must have opted in, and free-form replies are only allowed within 24 h of their last message.

## Approaches
- **computer-control:**
  - Chosen: text-based Accessibility control via JXA/`osascript`, with no dependencies.
  - Rejected for now: vision-based computer use. It needs image tool results in graphrt, which would be a change to graphrt itself.
  - Rejected for now: running the automation in a dedicated macOS VM. It fully solves the focus problem, but it is a deployment option rather than code.
- **WhatsApp in the background:**
  - Chosen: WhatsApp Web through Playwright headless, with a persistent profile and one QR login.
  - The official API is also built, as `whatsapp-api`, for business numbers.

## Common rules
Same as `2026-11-18-social-api-plugins-design.md`:
- one self-contained directory per plugin;
- `definition.mjs` + `operations/` + `lib/`;
- the shared runner (`lib/shared`, synced by `npm run sync`);
- every operation is a node and a tool, except `nodeOnly` ones;
- table-driven tests;
- one PR per plugin.

Plugins without a token use `resolveAccessToken: () => "local"`, so the runner does not demand one.

## whatsapp-api
- **Env:**
  - `WHATSAPP_ACCESS_TOKEN` (system-user or Page-style token)
  - `WHATSAPP_PHONE_NUMBER_ID`
  - `WHATSAPP_BUSINESS_ACCOUNT_ID` (WABA)
  - `WHATSAPP_GRAPH_VERSION` (default `v26.0`)
- **Base URL:** `https://graph.facebook.com/{ver}`, with Graph error mapping copied from meta-api.
- **Messaging:**
  - `send_text` (to, body, preview_url, reply_to_message_id)
  - `send_template` (to, name, language, components)
  - `send_media` (to, type image|video|audio|document|sticker, link or media_id, caption, filename)
  - `send_location`
  - `send_interactive_buttons` / `send_interactive_list`
  - `send_reaction`
  - `mark_as_read` (message_id, optional typing indicator)
- **Media:** `upload_media` (from URL, https only, size limit per type), `get_media_url`, `delete_media`.
- **Templates:** `list_templates`, `get_template`, `create_template`, `delete_template` (WABA).
- **Account:** `list_phone_numbers`, `get_business_profile`, `update_business_profile`.
- **Also:** `api_request`.
- **Rules:**
  - Phone numbers are validated as E.164 digits.
  - Code 131047 (outside the 24 h window) → `invalid_input`, with a hint to use a template.
  - Sends are POSTs, so they are never retried after an unknown outcome (the shared client already enforces this).
- **Not included:** incoming messages. They arrive only by webhook, so the README explains this.

## whatsapp-web
- **Dependency:** `playwright`, as in google-maps-scraper.
- **Session:**
  - A persistent Chromium profile in `WHATSAPP_WEB_PROFILE_DIR` (default `~/.graphrt/whatsapp-web/profile`).
  - The plugin process keeps **one** browser context alive across runs (lazy start, closed on shutdown or after `WHATSAPP_WEB_IDLE_MINUTES`, default 15) and serialises operations. Manifest `max_concurrency: 1`.
- **Login:**
  - `login` (node-only) opens a **visible** window so the user can scan the QR code, waits up to 3 minutes, then closes it. Later runs are headless.
  - `get_status` reports `logged_in`, `needs_login` (QR shown) or `loading`.
- **Reading:**
  - `list_chats`: name, last message preview, time, unread count; `unread_only`, `limit`.
  - `read_messages`: chat by name or phone number; last N messages with `from_me`, `sender`, `time`, `text`, `id`, read from `data-pre-plain-text` and `data-id`.
  - `search_chats`.
- **Sending:**
  - `send_message`: to a phone number (via `https://web.whatsapp.com/send?phone=<digits>`) or to an existing chat by exact name; verifies the message appears as sent.
  - `send_file`: local path or https URL, with caption.
- **Safety:**
  - Minimum interval between sends `WHATSAPP_WEB_MIN_SEND_INTERVAL_SECONDS` (default 30; raised from 5 after review because of the ban risk on a personal account).
  - Daily send cap `WHATSAPP_WEB_DAILY_SEND_LIMIT` (default 50), persisted in the profile dir.
  - Sends are never retried automatically.
  - Every send is logged to stderr.
- **Errors:**
  - Not logged in → `auth_error` ("run the login node").
  - Selector or timeout failure → `browser_error` with the step name.
  - Chat not found → `not_found`.

## computer-control (macOS)
- **Engine:** JXA through `osascript -l JavaScript` (child_process, argument passing via JSON on stdin, never string-interpolated into script source).
  - Accessibility through `System Events`.
  - Mouse and keyboard through `System Events` keystroke/key code and CGEvent via the ObjC bridge for clicks at coordinates.
  - Screenshots through `screencapture -x`.
- **Guardrails:**
  - `COMPUTER_CONTROL_ALLOWED_APPS` (comma-separated app names; **required**, so there is no default access). Every app-targeting operation checks it; `*` allows all apps (documented as risky).
  - Every action is logged to stderr.
  - No arbitrary AppleScript operation.
- **Operations:**
  - Apps and windows: `list_apps` (running, visible), `open_app`, `focus_app`, `quit_app` (node-only), `list_windows`.
  - Reading the UI:
    - `read_ui` (app, window index, max_depth, max_elements, text-only filter): elements as `{ref, role, title, value, description, enabled, focused, position, size}`.
    - `ref` is a stable path like `w1/3/2` within that snapshot.
    - `find_elements`: by role and/or a text contains-match.
  - Acting on elements: `click_element` (AXPress, falling back to a click at the element centre), `set_value` (AXValue for text fields), `focus_element`.
  - Keyboard: `type_text` (focuses the app first), `press_keys` (e.g. `cmd+f`, `enter`, `cmd+shift+4`; validated key names).
  - Pointer: `click_at` (x, y, button, double).
  - Clipboard: `get_clipboard`, `set_clipboard`.
  - Screen: `take_screenshot` (whole screen or app window, to `COMPUTER_CONTROL_SCREENSHOT_DIR`, default tmp; returns the path).
  - WhatsApp Desktop: `whatsapp_desktop_send` (chat name, text). This is a recipe on the primitives: focus WhatsApp, open search, type the name, pick the first result, type the message, press Enter. It needs `WhatsApp` in the allowlist.
- **Errors:**
  - Missing Accessibility or Screen Recording permission → `permission_denied`, naming the System Settings pane.
  - App not allowed → `permission_denied`.
  - App not running → `not_found`.
  - Stale ref → `not_found` ("read_ui again").
- **Platform:** on platforms other than macOS, every operation fails with `invalid_input` ("macOS only").

## Testing
- Unit tests with the osascript runner and Playwright page **injected/faked**: argument validation, allowlist, key parsing, element-tree formatting, rate limiter, the message parser fed sample DOM data, and error mapping.
- **Live checks, read-only only:**
  - computer-control: `list_apps`, `read_ui` on Finder/TextEdit, a screenshot.
  - whatsapp-web: `get_status` shows `needs_login` with a QR.
  - whatsapp-api: an invalid-token call.
- No message is sent live by agents; sends are verified only with fakes.

## Left to the builder
Exact selectors, JXA helper structure, and the element-ref encoding.
