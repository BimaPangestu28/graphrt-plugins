# macos-notifications

**Status:** stable · **ToS risk:** none. Local only; posted a real notification live (PR #48). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin that shows **local notifications on this Mac**, so a
workflow or agent can tell you when something finished or needs attention. It runs the system
`/usr/bin/osascript`; there is no network and nothing to install.

## Features
- **`notify`:** `message` (required), `notification_title` (default "graphrt"), `subtitle`, and an optional
  system `sound` (Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink).
  The title parameter is called `notification_title` because graphrt keeps `title` for a node's own label.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- macOS (on other systems every call returns `setup_required`). Node.js 20 or newer.
- macOS decides whether notifications from `osascript` are shown: the first one may ask for permission, and
  Focus modes or the notification settings for Script Editor can hide them. A call succeeds when macOS accepted the
  request; the plugin cannot see whether it was displayed.

## Installation
```bash
graphrt plugin install ./macos-notifications
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `MACOS_NOTIFICATIONS_TOOL_RATE_LIMIT` | `6` | Most notifications **agents** may post per minute (1 to 120); workflow nodes are not limited |

Local only: the plugin asks graphrt for no network access and no secrets.

## Quick Start
```bash
graphrt run macos-notifications/example.yaml --plugins .
```

## Usage
```yaml
- { id: done, type: macos-notifications.notify, notification_title: "Nightly report", message: "{{#summary.text#}}", sound: Glass }
```
Result: `{ "posted": true, "title": "Nightly report", "subtitle": "", "message": "...", "sound": "Glass" }`.

## Safety
- **No script injection, by construction:** the AppleScript is a constant (lib/notification-script.mjs). The
  text is passed to `/usr/bin/osascript` as separate process arguments after `--`, and the script reads them from
  `argv`. Values are never pasted into script source, so there is no quoting to escape or break, and a value such
  as `-e` is never read as an osascript option. Tests send payloads such as `" & (do shell script "...") & "` and
  check they only appear as arguments; an integration test runs the real osascript with the same mechanism and
  checks the payloads come back as literal strings and nothing is executed. Another test compiles the real script
  lines with `osacompile` (compiling never runs them).
- **No shell:** `osascript` is started by absolute path with an argument array, a 15 s timeout and SIGKILL on
  timeout or cancel.
- **Clean text:** C0 and C1 control characters (NEL included), the Unicode line and paragraph separators and the
  bidi embedding, override, isolate and mark characters are replaced with spaces (so a notification cannot show
  text in a different order than it says); title and subtitle are cut at 120 characters, the message at 1000.
- **Rate limit:** agent calls are limited per minute (in memory, per plugin process) and get `rate_limited` with a
  retry delay when over it, so an agent loop cannot flood the screen.

## Errors
| Kind | When |
|------|------|
| `setup_required` | Not macOS, or `/usr/bin/osascript` is missing |
| `invalid_input` | No visible message text, unknown sound |
| `rate_limited` | An agent posted more than `MACOS_NOTIFICATIONS_TOOL_RATE_LIMIT` in a minute (retryable) |
| `timeout` / `cancelled` | osascript did not finish in 15 s, or the call was cancelled |
| `plugin_error` | osascript failed; its message is included |

## License
Apache-2.0
