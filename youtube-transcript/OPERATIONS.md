# youtube-transcript operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `youtube-transcript.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_caption_tracks` | Lists a video's caption tracks (id, language, name, standard or auto-generated, draft, status) with the official YouTube Data API (OAuth; 50 quota units) | **video** |
| `get_transcript` | Downloads a caption track with the official YouTube Data API (captions.download, OAuth, 200 quota units; only for videos the authorised account can edit) and returns timed segments and plain text, or the raw file | video, language, caption_id, translate_to, format, max_chars |
| `parse_captions` | Parses WebVTT or SRT caption text you already have into timed segments and plain transcript text (no network, no credentials) | **content**, max_chars |
