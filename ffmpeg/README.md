# ffmpeg

**Status:** stable · **ToS risk:** none. Local only; its example workflow ran on real files during the build (PR #40). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **local media files** with the system
`ffmpeg`/`ffprobe`. Workflows and agents can inspect, convert, cut, join and render video and audio files that live in
directories you allow, and every result is a new file in one output directory. Tools choose from a fixed menu of
formats, codecs and quality levels; they never pass raw ffmpeg options.

## Features
- **`probe`:** container, duration, size, bit rate and streams (codec, resolution, frame rate, rotation, sample rate,
  channels, language); `include_raw` adds ffprobe's JSON.
- **`transcode`:** mp4, mov, mkv, webm, mp3, m4a, wav, flac, ogg or opus, with an allowed codec per format (h264,
  h265, vp9, av1; aac, mp3, opus, vorbis, flac, pcm) and `quality` low/medium/high. Workflow nodes may add
  allowlisted output options with `extra_args`.
- **`trim`:** `start` with `end` or `duration` (seconds or `HH:MM:SS.fff`); frame-accurate re-encode, or a fast stream
  copy with `accurate: false`.
- **`extract_audio`:** the first audio track as mp3, m4a, wav, flac, ogg or opus.
- **`thumbnail`:** one frame at `time` as jpg, png or webp, optionally scaled to `target_width`.
- **`resize`:** `target_width` and/or `target_height` (16–7680), aspect kept.
- **`concatenate`:** 2–50 files in order, by stream copy (all parts must share codecs and sizes) or `reencode: true`.
- **`burn_subtitles`:** draws the cues of an `.srt` file into the picture, with an optional `font_size`. Not on
  Windows yet: the plugin hands ffmpeg its own copy of the subtitles in the temporary folder, and a Windows path
  (`C:\...`) has characters the subtitles filter is not given, so the call is refused with `setup_required`.
- **`make_gif`:** up to 30 s at up to 30 fps and 1280 px wide, with a generated palette.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer.
- `ffmpeg` and `ffprobe` on `PATH` (`brew install ffmpeg`, `apt install ffmpeg`), or `FFMPEG_BINARY` /
  `FFPROBE_BINARY`. The presets use libx264, libx265, libvpx-vp9, libsvtav1, libopus, libmp3lame and libvorbis; a
  build without one of them fails only the operations that need it. Without ffmpeg every call returns
  `setup_required`.

## Installation
```bash
graphrt plugin install ./ffmpeg
```
There is nothing to `npm install`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `FFMPEG_INPUT_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that input files may be read from, subdirectories included |
| `FFMPEG_OUTPUT_DIR` | (none) | Existing directory for outputs. Without it only `probe` works; the rest return `setup_required`. Outputs can be read back as inputs. |
| `FFMPEG_MAX_INPUT_BYTES` | 2 GiB | Largest input file |
| `FFMPEG_MAX_OUTPUT_BYTES` | 2 GiB | Largest output (ffmpeg's `-fs`); an output that reaches it is removed and the call fails |
| `FFMPEG_TIMEOUT_MS` | `600000` | Per ffmpeg/ffprobe run (1000 to 1780000); the process is killed when it passes |
| `FFMPEG_MAX_INPUT_PIXELS` | `33177600` (8K) | Most pixels (width × height) of any video stream an operation decodes; also passed as `-max_pixels` |
| `FFMPEG_MAX_INPUT_SECONDS` | `3600` | Longest input (or concatenation) an **agent** tool call may process; nodes are not limited |
| `FFMPEG_THREADS` | `4` | Decoder, encoder and filter threads per run (1 to 64) |
| `FFMPEG_BINARY`, `FFPROBE_BINARY` | `ffmpeg`, `ffprobe` on `PATH` | Absolute paths to the programs |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

## Quick Start
```bash
mkdir -p ~/media/in ~/media/out
ffmpeg -f lavfi -i testsrc=duration=1:size=320x240:rate=10 -pix_fmt yuv420p ~/media/in/clip.mp4
export FFMPEG_INPUT_DIRS=~/media/in FFMPEG_OUTPUT_DIR=~/media/out
graphrt run ffmpeg/example.yaml --plugins .
```

## Usage
Paths may be absolute, `~/...`, or relative to the first input directory. Results look like:
```json
{ "path": "/Users/me/media/out/clip-20261119-080102-1a2b3c4d.webm", "file_name": "clip-20261119-080102-1a2b3c4d.webm", "size_bytes": 48211, "format": "webm" }
```
`output_name` sets the start of the generated name; the timestamp and random suffix are always added.

## Safety
- **Files:** inputs must be regular files inside `FFMPEG_INPUT_DIRS` (or `FFMPEG_OUTPUT_DIR`), checked after
  `realpath` on both sides with a separator-suffixed prefix; symlinks out, `../`, FIFOs and devices are refused, and
  a file outside the allowlist gets the same `not_found` as a missing one. Only media extensions are accepted.
- **Outputs:** ffmpeg writes into a private (0700) `.staging-*` directory inside `FFMPEG_OUTPUT_DIR` with `-n`;
  only a finished, size-checked file is hard-linked to its generated name (`link()` never replaces an existing
  file) and the staging directory is removed. Nothing is overwritten — not the input, not an earlier output — and
  no output path is reopened after the fact. Failed, cancelled, timed-out or oversized outputs are removed.
- **Decoded size:** a small file can declare an enormous picture or hours of content. Every operation that decodes
  probes its inputs first and refuses a video stream over `FFMPEG_MAX_INPUT_PIXELS`, and, for agent tool calls,
  inputs (or concatenations) longer than `FFMPEG_MAX_INPUT_SECONDS`. Each input also gets `-max_pixels` and
  `-threads`, and filters `-filter_threads`.
- **Hard links:** inputs with more than one hard link are refused, since a hard link inside an allowed directory
  could point at a file outside it.
- **Error messages** keep ffmpeg's own reason but replace paths outside the allowed directories (temp files,
  library locations) with `[path]`.
- **No shell, no protocols:** ffmpeg is started with an argument array. Every input is passed as `file:<real path>`
  with `-protocol_whitelist file` (so `concat:`, `http(s):`, `pipe:`, `data:`, `subfile:`, `tcp:` and the rest are
  refused, also inside playlists) and `-format_whitelist` of plain media demuxers (no HLS/DASH playlists, concat
  scripts, image sequences, `lavfi` or devices). A playlist renamed to `.mp4` is refused.
- **Concatenation** writes its own ffconcat list (quotes escaped, control characters refused) to a private temp
  directory, and every part is probed with the strict demuxer list first, so a part can't be another list.
- **Subtitles:** the `.srt` file is parsed and a clean copy is written to a private temp directory; ffmpeg only
  ever sees that copy, so a disguised playlist can't reach the `subtitles` filter.
- **Agents vs nodes:** tools pick formats, codecs, qualities, times and sizes only, all validated. `extra_args` is
  for workflow nodes, and even there it is an allowlist of output options (`-crf`, `-preset`, `-tune`, `-b:v`,
  `-b:a`, `-maxrate`, `-bufsize`, `-r`, `-g`, `-ac`, `-ar`, `-pix_fmt`, `-profile:v`, `-level`, `-movflags`,
  `-q:a`, `-threads`, `-an`, `-vn`, `-sn`) with checked values — no filters (`-vf movie=...`), inputs, formats or
  paths. Writing new files to the output directory is allowed for tools: setting `FFMPEG_OUTPUT_DIR` is the opt-in.
- **Limits:** a timeout per run (SIGKILL), cancel kills ffmpeg at once, input and output size caps, two calls at a
  time.

## Errors
| Kind | When |
|------|------|
| `setup_required` | ffmpeg/ffprobe missing, `FFMPEG_INPUT_DIRS` or (for outputs) `FFMPEG_OUTPUT_DIR` unset |
| `not_found` | The file is missing or outside the allowed directories |
| `invalid_input` | Bad arguments, not a media file, refused demuxer, no audio track, stream over the pixel cap, input too long for an agent call, output over the cap |
| `permission_denied` | A tool passed `extra_args` |
| `timeout` / `cancelled` | The run passed `FFMPEG_TIMEOUT_MS` or was cancelled; nothing is kept |
| `plugin_error` | ffmpeg failed for another reason (its last message is included) |

## License
Apache-2.0
