# computer-control

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that controls **macOS desktop apps**. It reads an app's
UI from the macOS Accessibility tree, which is text, so agents can "see" it. It can then click elements, type, press
key combos, use the clipboard and save screenshots. Every operation is a workflow node and, except `quit_app` and
`whatsapp_desktop_send`, an agent tool.

The plugin is built for an unlocked, logged-in Mac that it may take over for a moment. Typing and clicking bring the
target app to the front, so the plugin takes keyboard focus while it works.

## Features
- **Apps and windows:** `list_apps`, `open_app`, `focus_app`, `quit_app` (node only), `list_windows`.
- **Reading the UI:**
  - `read_ui` returns elements `{ref, role, title, value, description, placeholder, enabled, focused, position, size}`, plus `data.text`, a compact indented outline that agents read.
  - `find_elements` finds elements by role and/or text.
- **Acting on elements:** `click_element` uses AXPress and falls back to a mouse click at the element's centre. Also `set_value` and `focus_element`.
- **Keyboard and pointer:** `type_text` (key by key, inserted through Accessibility, or pasted), `press_keys` (`cmd+f`, `enter`, `cmd+shift+n`, `cmd+a delete`), `click_at`.
- **Clipboard:** `get_clipboard` (opt-in), `set_clipboard` (plain text).
- **Screen:** `take_screenshot` saves one app window (or, opt-in, the whole screen) as a PNG and returns its path.
- **WhatsApp Desktop:** `whatsapp_desktop_send` (chat name, text) is a recipe built on the operations above. It is a workflow node only.
- **Guardrails:**
  - An app allowlist is required.
  - Every action is logged to stderr. Typed text is logged as its length only.
  - Operations run one at a time.
  - There is no "run arbitrary AppleScript" operation.
  - The manifest asks for no network access and no secrets (`localOnly`).

Full operation reference: [OPERATIONS.md](OPERATIONS.md). (Its note that nodes accept `access_token` does not apply
here: this plugin has no token.)

## Prerequisites
- macOS. On other platforms every operation fails with `invalid_input` ("macOS only").
- Node.js >= 20, graphrt with plugin support.
- Permissions for the app that runs graphrt (Terminal, iTerm, your IDE…), in System Settings → Privacy & Security:
  - **Accessibility:** needed to read the UI, click, type and press keys.
  - **Automation → System Events:** macOS asks for this the first time a keystroke or focus change is sent.
  - **Screen & System Audio Recording:** needed for `take_screenshot`. Without it, macOS may save an image that shows only the desktop wallpaper.

## Installation
```bash
graphrt plugin install ./computer-control
```
You don't need to run `npm install`. The plugin has no dependencies: it uses `/usr/bin/osascript`, `/usr/bin/open` and `/usr/sbin/screencapture`.

## Configuration
| Env var | Required | Description |
|---------|----------|-------------|
| `COMPUTER_CONTROL_ALLOWED_APPS` | yes | Comma-separated app names or bundle ids the plugin may control, e.g. `Finder,TextEdit,net.whatsapp.WhatsApp`. ASCII letters are case-insensitive. `*` allows **every** app. That is risky: an agent could then type into your terminal or password manager. |
| `COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ` | no | Set to `1` to allow `get_clipboard`. The clipboard holds whatever was last copied in **any** app, passwords included. |
| `COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT` | no | Set to `1` to allow `take_screenshot` without `app` (the whole screen, which shows every app). Window screenshots don't need it. |
| `COMPUTER_CONTROL_SCREENSHOT_DIR` | no | Where screenshots go (default `$TMPDIR/graphrt-computer-control`) |

Every operation that targets an app checks it against the allowlist before any script runs. If
`COMPUTER_CONTROL_ALLOWED_APPS` is unset, every operation fails with `permission_denied`, including the clipboard
operations and `list_apps`. `list_apps` shows every running app and marks which ones are allowed.

App names are matched after Unicode NFC normalisation, with only ASCII letters folded to lower case. A name that
contains look-alike characters that NFC rewrites (such as the Kelvin sign `K`, U+212A) never matches, and such an
allowlist entry is rejected. Only regular (Dock) apps are targets. If two running apps match a name, the operation
fails with `invalid_input` and lists them: pass the bundle id instead, and allow that bundle id.

## Quick Start
```bash
COMPUTER_CONTROL_ALLOWED_APPS=Finder graphrt run computer-control/example.yaml --plugins .
```

## Usage
```yaml
- id: ui
  type: computer-control.find_elements
  app: TextEdit
  role: textarea
- id: focus
  type: computer-control.focus_element
  app: TextEdit
  ref: "{{#ui.data.elements.0.ref#}}"
- id: type
  type: computer-control.type_text
  app: TextEdit
  text: "Hello from graphrt"
  method: insert
```

### Element refs
`read_ui` and `find_elements` return a `ref` for every element, e.g. `w1/3/2#0a1b2c3`:
- `w1` is the first window, as listed by `list_windows`.
- `w1/3/2` is the 2nd child of the window's 3rd child. All indexes are 1-based.
- `#0a1b2c3` is a fingerprint of the element's role, subrole, title, description and placeholder (and the text of
  static text). Focus, position and the value of editable fields are not part of it.

`click_element`, `set_value` and `focus_element` need the ref with its fingerprint, exactly as returned. The plugin
resolves the path again on every use and checks the fingerprint. If the path no longer exists, or now leads to a
different element, the operation fails with `not_found` ("call read_ui again") and does nothing. Raising another
window renumbers the windows (`w1` is always the frontmost).

### Reading big windows
`read_ui` reads up to `max_depth` levels (default 8) and `max_elements` elements (default 300). A walk inspects at
most 5000 elements. The output (elements plus `data.text`) is capped at about 60,000 characters. If any of these
limits cut the output, `data.text` says so and `data.output_truncated` is true. Then pass a ref as `root_ref` to read
one sub-tree, or use `find_elements`.

### Typing
`type_text` has three methods:
- `keystroke` (default, at most 1000 characters): types key by key in 200-character chunks. `"\n"` presses Return.
- `insert`: inserts the text into the focused text field through Accessibility (`AXSelectedText`). It sends no keys
  and doesn't touch the clipboard, and `"\n"` is a line break. The field is read back, and the call fails if the text
  didn't arrive. Some apps don't accept text this way.
- `paste`: puts the text on the clipboard and presses Cmd+V. It then reads the field back to confirm the text arrived
  before it restores the clipboard (every item and type, not only plain text). If the field doesn't expose its text,
  the call fails even though the paste may have happened.

Line endings are normalised to `\n`.

### WhatsApp Desktop
`whatsapp_desktop_send` is a **workflow node only**. A tool call can't be cancelled, and a timed-out tool call that
still pressed Return would send twice. Agents should send through the `whatsapp-web` or `whatsapp-api` plugins
instead.

It needs WhatsApp for Mac running and `WhatsApp` (or `net.whatsapp.WhatsApp`, which it then uses) in the allowlist.
It runs these steps, and each check fails **before anything is sent**:
1. Bring WhatsApp to the front and press Cmd+F. The focused element must be a search field. Only then does the recipe clear it (Cmd+A Delete) and insert the chat name, and both steps check that field still has focus.
2. Find the chat list: a list, table or outline under the search field. Only matches inside it count, not message bubbles, sender labels or the header. A cell and its label in the same row count as one match. No match fails with `not_found` and more than one chat with that name fails with `invalid_input`. Both press Escape.
3. Click the chat. The conversation header (right of the chat list, in the top 110 points of the window) must read the chat name.
4. The message box (the lowest text area right of the chat list) must exist, take focus and be empty. A draft fails with `invalid_input`. The message is inserted through Accessibility, never pasted, and read back.
5. Check the header again. Then press Return, and only if WhatsApp is still frontmost and the message box still has focus.

It returns `delivery_confirmed: false`, because it doesn't check that the message appears as sent.

> **Unverified:** WhatsApp publishes no keyboard-shortcut or Accessibility reference for its Mac app. These are
> assumptions, untested against a live WhatsApp window:
> - Cmd+F opens chat search, and the search field reports `AXTextField`/`AXSearchField`.
> - The chat list is an `AXTable`, `AXOutline` or `AXList` under the search field.
> - The header shows the chat name in the top 110 points, and the message box is an `AXTextArea`.
> - WhatsApp accepts text inserted through `AXSelectedText`.
>
> If an assumption doesn't hold, the recipe fails with an error and sends nothing. Try it on a chat with yourself
> first.

## Errors
| Kind | When |
|------|------|
| `screen_locked` | The Mac's screen is locked (the login window is frontmost). macOS blocks input until it is unlocked; nothing was typed or clicked. |
| `action_failed` | macOS refused an action, e.g. the app could not be brought to the front. |
| `permission_denied` | The app is not in `COMPUTER_CONTROL_ALLOWED_APPS`, the variable is unset, or a macOS permission is missing (the message names the System Settings pane). Also: focus left the target app mid-operation, a click point is covered by another app, a system-wide shortcut was refused, or an opt-in variable is not set. |
| `not_found` | The app is not running or not installed, the window doesn't exist, a ref is stale or now points at another element ("read_ui again"), or a WhatsApp chat, header or message box isn't found |
| `invalid_input` | Bad arguments, an unknown key name, a ref with the wrong shape or no fingerprint, a point outside the app's windows, an ambiguous app name or WhatsApp chat name, or not macOS |
| `timeout`, `cancelled` | osascript was killed after its time limit (30 s; 60 s for tree walks and typing), or the run was cancelled. Tool calls are cancelled 10 s before the host's 120 s tool timeout. |
| `plugin_error` | Any other osascript, AX action or screencapture failure, including typed text that could not be confirmed |

## Security notes
- Arguments reach the JXA scripts as JSON on stdin. They are never put into script source, and no shell is used.
- Input stays in the target app as far as the plugin can check:
  - `type_text`, `press_keys`, `click_at` and `click_element` check that the target app is still frontmost before every key step, text chunk and click. They stop with `permission_denied` as soon as another app takes focus.
  - Before a click, the plugin hit-tests the point. The element under it must belong to the target app, and an element-centre click must also fall inside the element's window.
  - `press_keys` refuses system-wide shortcuts before any script runs: `cmd+tab`, `` cmd+` ``, `cmd+space`, `ctrl+space`, `ctrl`+arrow keys, `cmd+opt+esc`, `ctrl+cmd+q`, `cmd+shift+3/4/5`, `cmd+h`, `cmd+q` (use `quit_app`) and `cmd+m`, plus the same combos with extra modifiers.

  A check and the input event that follows it are still separate steps. Focus that changes in the few milliseconds between them isn't caught, so treat this as damage limitation, not isolation.
- `get_clipboard` and full-screen screenshots are outside the app allowlist, so each needs its own opt-in variable. A window screenshot captures that window by its window id, so other apps' windows on top of it never appear.
- `quit_app` and `whatsapp_desktop_send` are node only, so agents can't quit apps or send WhatsApp messages through this plugin.

## Development
From the repo root, run `npm run sync` after changing `definition.mjs`, `operations/` or `shared/`, then run `npm test`.
`lib/shared/` is a generated copy of `/shared/lib`, so don't edit it. The JXA scripts are in `jxa/`. Each one is
`prelude.js` plus `<name>.js`. The tests compile all of them with `osacompile`.

`test/jxa-scripts.test.mjs` runs the real script source in a Node `vm` sandbox (`test/jxa-harness.mjs`) with every
ObjC call and side effect faked. It covers the frontmost checks, chunking, paste confirmation, fingerprints,
hit-tests and app lookup without touching the keyboard, mouse, clipboard or any app.

## License
Apache-2.0
