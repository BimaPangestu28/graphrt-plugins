# computer-control operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `computer-control.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_apps` | List running apps that have a Dock icon, with which one is frontmost and whether COMPUTER_CONTROL_ALLOWED_APPS allows it. data.text is a readable summary. |  |
| `open_app` | Launch an app (or bring it to the front if it is already running), like `open -a` (or `open -b` for a bundle id such as net.whatsapp.WhatsApp). | **app** |
| `focus_app` | Bring a running app to the front so it receives keyboard input. | **app** |
| `quit_app` | Ask a running app to quit, like Cmd+Q (it may still ask to save documents). Workflow node only, never an agent tool. | **app** |
| `list_windows` | List an app's windows (ref w1 = frontmost) with title, position and size. data.text is a readable summary. | **app** |
| `read_ui` | Read a window's Accessibility tree as elements {ref, role, title, value, description, enabled, focused, position, size}. data.text is a compact indented outline; pass the refs exactly as shown (e.g. w1/3/2#0a1b2c3) to click_element, set_value and focus_element. A ref fails with not_found once that element changed: read_ui again. Long output is cut (data.output_truncated). | **app**, window, root_ref, max_depth, max_elements, text_only |
| `find_elements` | Find elements in a window by role (e.g. "button", "AXTextField") and/or text contained in their title, value, description or placeholder (case-insensitive). | **app**, window, root_ref, role, text, exact, max_depth, max_results |
| `click_element` | Press an element by ref (AXPress). If it has no press action, click its centre with the mouse (brings the app to the front); the click is refused when the centre is outside the element's window or another app's window covers it. | **app**, **ref**, fallback_click |
| `set_value` | Set the text of a text field or text area by ref (AXValue), without typing. Some apps ignore values set this way; then use focus_element + type_text. | **app**, **ref**, **value** |
| `focus_element` | Bring the app to the front and move keyboard focus to an element by ref, e.g. before type_text. | **app**, **ref** |
| `type_text` | Bring an app to the front and type text into its focused element. method keystroke (default, at most 1000 characters) types key by key in chunks, and "\n" presses Return; insert puts the text into the focused text field through Accessibility (no keys, no clipboard; "\n" is a line break) and checks it arrived; paste uses the clipboard, checks the text arrived, then restores the clipboard. Typing stops if another app takes focus. | **app**, **text**, method |
| `press_keys` | Bring an app to the front and press key combos, e.g. "cmd+f", "enter", "cmd+shift+n" or a space-separated sequence "cmd+a delete". Modifiers: cmd, shift, ctrl, opt. Keys: letters, digits, punctuation, enter, tab, space, delete, escape, arrows (up/down/left/right), home, end, pageup, pagedown, f1-f12. System-wide shortcuts (cmd+tab, cmd+space, ctrl+arrows, cmd+q, cmd+h, cmd+m, screenshots, lock screen, force quit) are refused. | **app**, **keys** |
| `click_at` | Bring an app to the front and click at screen coordinates (points, as in read_ui positions). The point must be inside one of that app's windows and not covered by another app's window. | **app**, **x**, **y**, button, double |
| `get_clipboard` | Read the clipboard as plain text (null when it holds no text). Needs COMPUTER_CONTROL_ALLOW_CLIPBOARD_READ=1, because the clipboard may hold anything copied in any app. |  |
| `set_clipboard` | Replace the clipboard with plain text. | **text** |
| `take_screenshot` | Save a PNG screenshot of one app window (when `app` is given; only that window, by window id) or of the main display (needs COMPUTER_CONTROL_ALLOW_FULL_SCREENSHOT=1) to COMPUTER_CONTROL_SCREENSHOT_DIR (default: a temp folder). Returns the file path; agents cannot see the image, use read_ui to read the UI. | app, window |
| `whatsapp_desktop_send` | Workflow node only: send a message in the WhatsApp for Mac app to an existing chat, by its exact name. Opens search, requires exactly one chat-list match, checks the conversation header and the empty message box, inserts the message and presses Return. Takes keyboard focus for a few seconds. Needs WhatsApp (or net.whatsapp.WhatsApp) in COMPUTER_CONTROL_ALLOWED_APPS. Never retried automatically. | **chat**, **text** |
