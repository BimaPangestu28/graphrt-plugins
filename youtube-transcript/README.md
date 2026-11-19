# youtube-transcript

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **YouTube captions through the official
YouTube Data API v3 only**. It lists a video's caption tracks and downloads one as timed segments and plain text,
and it parses WebVTT/SRT caption files you already have.

**Read this first, it limits what the plugin can do:** the official `captions.download` method only works for
videos the authorised Google account **can edit** (your own channel, or a channel that made you a manager). For
anyone else's video YouTube answers `403 forbidden`, and this plugin returns that as `permission_denied`. There is
no official API for transcripts of arbitrary public videos.

## Why there is no "any public video" mode
Tools such as `youtube-transcript-api` and `yt-dlp` read captions of any video through YouTube's internal
endpoints (the watch page, the `youtubei/v1/player` "innertube" API with a spoofed client, and the
`/api/timedtext` URLs it returns). This plugin does not, on purpose:
- **Terms of Service:** YouTube's Terms forbid accessing the service "using any automated means (such as robots,
  botnets or scrapers)" except public search engines or with YouTube's written permission. The developer policies
  require the documented API for programmatic access.
- **Fragility:** those endpoints are undocumented and change without notice. Since 2024 the web `timedtext` URLs
  need a "proof of origin" (PO) token and return empty bodies without it; the workarounds rotate between spoofed
  client types and break every few months, and cloud IP ranges are often blocked outright.

So the defensible paths are: the official API for videos you control, or `parse_captions` for a caption file you
are entitled to (for example one exported from YouTube Studio, or delivered by the video's owner).

## Features
- **`list_caption_tracks`:** `captions.list` (50 quota units): id, language, name, `track_kind` (`standard`,
  `asr` auto-generated, `forced`), CC, draft and status.
- **`get_transcript`:** picks the best published track (in `language` when given; standard, then forced, then
  auto-generated) or uses `caption_id`, then `captions.download` (200 quota units). With `caption_id`, `video` is
  not needed and `video_id` in the result is `null`, since the track's video is not checked. `format: segments`
  (default) returns `segments` (`start_seconds`, `end_seconds`, `text`) and one `text`; `max_chars` bounds both
  (rolling auto-captions repeat lines, so segments can be longer than the text) and `truncated` says either was cut; `vtt`, `srt`, `ttml` or `sbv` return the file as `caption_file`. `translate_to` asks YouTube for a
  machine translation (`tlang`).
- **`parse_captions`:** WebVTT or SRT text (at most `YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES`) to segments and text,
  with no network or credentials. Repeated lines from rolling auto-captions are collapsed in `text`. Cues with
  impossible timestamps (minutes or seconds of 60 or more, or ending before they start) are skipped.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer. No npm dependencies.
- A Google Cloud project with the YouTube Data API v3 enabled and an OAuth client. The token needs the
  `https://www.googleapis.com/auth/youtube.force-ssl` scope (an API key is not accepted for captions).

## Installation
```bash
graphrt plugin install ./youtube-transcript
```

## Configuration
The same credentials as the [youtube-api](../youtube-api/) plugin (its OAuth module is copied here; keep the copies
in step):

| Variable | Meaning |
|----------|---------|
| `YOUTUBE_ACCESS_TOKEN` | A ready OAuth access token (expires after about an hour) |
| `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | Refresh trio; access tokens are fetched and cached automatically |
| `YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES` | Largest caption file downloaded or parsed (default 5 MiB, 65536 to 64 MiB) |

A node may pass `access_token` from a secret (needs `--trust-plugin youtube-transcript`). Tools never take
credentials as arguments. Tokens and client secrets are redacted from errors.

## Quick Start
```bash
export YOUTUBE_REFRESH_TOKEN=... YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=...
graphrt run youtube-transcript/example.yaml --plugins .
```
Replace the video in `example.yaml` with one of your own videos.

## Usage
```yaml
- { id: transcript, type: youtube-transcript.get_transcript, video: "https://youtu.be/VIDEO_ID", language: en }
- { id: parsed, type: youtube-transcript.parse_captions, content: "{{#read.data.content#}}" }
```
Result of `get_transcript`:
```json
{ "video_id": "VIDEO_ID", "track": { "id": "...", "language": "en", "track_kind": "standard" }, "translated_to": null,
  "format": "segments", "segments": [{ "start_seconds": 0, "end_seconds": 2.5, "text": "Hello there" }],
  "text": "Hello there ...", "truncated": false }
```

## Safety
- All operations only read, so all are agent tools. Each `get_transcript` costs 250 quota units (list + download)
  of the default 10000 a day; pass `caption_id` to save the 50 of the listing.
- `video` must be an 11-character id or a youtube.com / youtu.be URL; any other host is refused, and the track id
  in the download path is encoded as one path segment.
- Caption downloads and `parse_captions` input are capped by `YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES`, transcripts
  (text and segments) by `max_chars`. Tags are stripped with a linear pattern.
- A refused `captions.download` names the edit-permission rule; `insufficientPermissions` names the scope the token
  needs.

## Errors
| Kind | When |
|------|------|
| `auth_error` | No credentials, or the token was rejected (and could not be refreshed) |
| `permission_denied` | The account cannot edit the video (`captions.download` refused), or the token lacks the scope |
| `not_found` | Video, track, or no published track in the language (the message lists the languages there are) |
| `rate_limited` | The daily quota is used up (not retried) or a short rate limit |
| `invalid_input` | Bad video id or URL, bad language code, caption text without cues |
| `api_error` / `network_error` | Other API failures; network errors are retryable |

## License
Apache-2.0
