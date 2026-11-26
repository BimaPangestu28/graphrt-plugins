# meeting-notes

**Status:** beta · **ToS risk:** none. Local only; detected a meeting app on the microphone, recorded both tracks, auto-stopped and transcribed live with the downloaded whisper.cpp (PipeWire 1.6, Ubuntu); not yet used on a real call. See [plugin status](../README.md#plugin-status).

> **Warning:** recording people may need their consent where you live. The plugin never records on its own; the
> example workflow asks first and shows a reminder to tell the other participants.

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **meeting notes taken on your own computer**. No bot joins
the call and no Zoom / Meet / Teams API is used. It notices that a meeting app is using the microphone, records your
microphone and the computer's sound as two separate tracks (so the transcript knows who spoke: **You** and
**Others**), and transcribes them **locally** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Summaries
and delivery are ordinary workflow steps (`llm`, then any plugin: notion-api, slack, email…).

Linux with PipeWire for now (every current desktop distribution). macOS and Windows will follow with their own
recording backends.

## Features
- **`detect`:** which meeting apps (Zoom, Teams, Slack, Discord, Webex, Skype, browsers) use the microphone now;
  volume meters and audio tools are ignored. Read only, also an agent tool.
- **`wait_for_meeting`:** long-polls until a meeting app has used the microphone for `confirm_seconds` (5), then
  returns one event; each meeting is reported once, never while recording.
- **`start_recording`:** two `pw-record` tracks, 16 kHz mono WAV (`mic.wav`, `system.wav` from the default sink's
  monitor), watched by a small **detached** supervisor: it keeps recording if the host restarts, and stops when
  `stop_recording` is called or no meeting app has used the microphone for `MEETING_NOTES_AUTO_STOP_SECONDS` (30).
- **`recording_status`**, **`stop_recording`**.
- **`wait_for_recording_end`:** long-polls for meetings whose recording ended since a cursor.
- **`transcribe`:** a simple voice activity detector skips silent tracks and drops whisper lines over silence (no
  invented text on a quiet microphone), each track is transcribed on its own and merged by time into
  `[00:01:05] You: …` paragraphs. The audio is **deleted afterwards** unless `keep_audio: true`. A meeting already
  transcribed returns its transcript, so several workflows can share one meeting.
- **Triggers** (for hosts such as graphrt Desktop): `meeting_detected` (watch `wait_for_meeting`) and
  `meeting_recorded` (watch `wait_for_recording_end`). The host long-polls them outside runs and starts one run per
  event, with the event's fields as inputs.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Linux with PipeWire and its tools `pw-dump` and `pw-record` (`pipewire-bin` on Debian/Ubuntu, `pipewire` on Fedora
  and Arch). Node.js 20 or newer. No npm dependencies.
- For transcription, nothing to install: the first `transcribe` downloads into `MEETING_NOTES_WHISPER_DIR`
  - `whisper-cli` (4 MB, whisper.cpp v1.9.6 built statically for x86-64-v3 / glibc 2.35+, MIT license) from the
    [`whisper-cpp-v1.9.6` prerelease](https://github.com/Graphrt/graphrt-builder-desktop/releases/tag/whisper-cpp-v1.9.6)
    of graphrt Desktop, and
  - `ggml-base.bin` (148 MB, multilingual) from whisper.cpp's Hugging Face repository,
  both pinned by SHA-256 and fetched over https from public hosts only. A `whisper-cli` already on `PATH` (or in that
  directory) is used instead; other CPU architectures need one.

## Installation
```bash
graphrt plugin install ./meeting-notes
```

## Environment variables
All optional.

| Variable | Default | Meaning |
|----------|---------|---------|
| `MEETING_NOTES_DIR` | `~/.local/share/graphrt-meeting-notes` | Where meetings are stored, one folder each (`meta.json`, tracks, `transcript.md`) |
| `MEETING_NOTES_WHISPER_DIR` | `<MEETING_NOTES_DIR>/whisper` | Where whisper.cpp is downloaded |
| `MEETING_NOTES_AUTO_STOP_SECONDS` | `30` | Stop recording this long after the last meeting app left the microphone (5 to 3600) |
| `MEETING_NOTES_LANGUAGE` | `auto` | Default transcription language (`auto`, `en`, `id`, …) |

graphrt starts plugins with a clean environment; the plugin finds PipeWire's socket under `/run/user/<uid>` when
`XDG_RUNTIME_DIR` is not passed.

## Credentials
None. Everything runs on this computer; the only network use is the one-time whisper.cpp download.

## Scopes
None.

## Pricing
Free. Transcription uses this computer's CPU (whisper `base` on 8 threads: roughly 20–40× real time).

## Usage
Two workflows, one per trigger ([examples/](examples/)):

1. **`meeting_detected` → ask → record** ([examples/ask-and-record.yaml](examples/ask-and-record.yaml)):
   a `human-input` step "Meeting detected: Zoom is using the microphone. Take notes?" with the consent reminder, then
   `start_recording`. Recording continues after the run ends.
2. **`meeting_recorded` → transcribe → summarize**
   ([examples/transcribe-and-summarize.yaml](examples/transcribe-and-summarize.yaml)): `transcribe` with
   `meeting_id: "{{#start.meeting_id#}}"` and `timeout_ms: 1800000` (an hour of audio takes minutes), an `llm`
   summary, then send it with any plugin.

To stop before the meeting ends, run `stop_recording` (for example from a second `human-input` "Stop" step, or an
agent's "Run now").

Without a host that runs triggers, call the watch operations yourself:
```yaml
- { id: wait, type: meeting-notes.wait_for_meeting, timeout_seconds: 240 }
```
They return `{ events, cursor }`; pass `cursor` back to continue without repeats.

## Agent policy
- **Tools:** `detect` and `recording_status` only (read only).
- **Node only:** `wait_for_meeting`, `start_recording`, `stop_recording`, `wait_for_recording_end` and `transcribe`.
  An agent can never start a recording.

## Safety
- Records only after a workflow step asks for it (`start_recording`); detection reads PipeWire's object list only.
- Files stay in `MEETING_NOTES_DIR`; meeting ids are checked (`YYYYMMDD-HHMMSS-hex`), so a path never leaves it.
- Downloads: https, public hosts, redirect hops re-checked, size caps, SHA-256 pinned; a mismatch installs nothing.
- The recorder's own streams are named `graphrt-meeting-*` and never count as a meeting.
- Use headphones: without them the other side also reaches your microphone and may appear twice.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | Bad id, language or cursor; already recording; transcribing a meeting still being recorded |
| `not_found` | Unknown meeting, audio already deleted, or no whisper-cli for this platform |
| `api_error` | `pw-dump` or `whisper-cli` failed, a download did not match its SHA-256, or a stop timed out |
| `cancelled` | The run was cancelled during a wait or a transcription |

## License
Apache-2.0. whisper.cpp (downloaded at run time) is MIT, © The ggml authors.
