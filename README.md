# graphrt-plugins

## Overview
A collection of plugins for [graphrt](https://github.com/BimaPangestu28/graphrt). Each directory is one plugin with
its own `graphrt-plugin.json`, and it can be installed on its own.

## Plugins
| Plugin | What it does | Operations |
|--------|--------------|-----------:|
| [google-maps-scraper](google-maps-scraper/) | Searches Google Maps with a headless browser and extracts business phone numbers (free, no API key) | 1 |
| [meta-api](meta-api/) | Facebook Page posts and comments, Instagram publishing and comments, Messenger and Instagram Direct | 25 |
| [threads-api](threads-api/) | Threads profile, publishing, replies, moderation, mentions and search | 16 |
| [x-api](x-api/) | X posts, replies, likes, reposts, DMs and media upload (X bills per request) | 21 |
| [youtube-api](youtube-api/) | YouTube channel, videos, comments, moderation and live chat | 15 |
| [linkedin-api](linkedin-api/) | LinkedIn posts, images, comments and reactions for members and organizations | 15 |
| [tiktok-api](tiktok-api/) | TikTok profile, videos and publishing, plus comments and DMs via the Business API | 19 |
| [computer-control](computer-control/) | Control macOS apps (incl. WhatsApp Desktop) via the Accessibility tree: read UI, click, type, keys, clipboard, screenshots — limited to an app allowlist | 17 |
| [whatsapp-web](whatsapp-web/) | Your personal WhatsApp in the background via a headless WhatsApp Web session: read chats, send messages and files (rate limited) | 7 |
| [whatsapp-api](whatsapp-api/) | WhatsApp Business Cloud API: send text, templates, media and interactive messages, manage templates and the profile | 19 |

- **Node and tool:** every API operation is a workflow node (`<plugin>.<operation>`) and an agent tool (`<operation>`).
  The exception is token refresh, which is node only, so tokens never reach an LLM.
- **Operation lists:** each plugin's full list is in its `OPERATIONS.md`, and its setup (tokens, permissions,
  platform limits) is in its `README.md`.

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- The API plugins have no npm dependencies. `google-maps-scraper` needs Playwright and Chromium (see its README).

## Usage
```bash
graphrt run <workflow.yaml> --plugins /path/to/graphrt-plugins
# or install a single plugin
graphrt plugin install ./meta-api
```

## Development
- **Shared library:** the API plugins share `shared/lib`: an HTTP client with safe retries, an origin guard and
  token redaction, plus argument validation, the operation runner, polling and `api_request`.
- **Generated files:** `npm run sync` copies `shared/lib` into each plugin's `lib/shared/` and regenerates each
  `graphrt-plugin.json` and `OPERATIONS.md` from `definition.mjs`. Never edit those generated files by hand.
- **Tests:** `npm test` runs every suite and fails when the generated files are out of date.

Design notes and API research are in `docs/superpowers/`.

## License
Apache-2.0
