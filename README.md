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

## Install
Every plugin version is published as a GitHub Release with a ready-to-run tarball, and one `catalog` release
lists them all.

- **Release:** tag `<name>-v<version>` (pre-release while the version is 0.x) with the asset
  `<name>-<version>.tar.gz`. The tarball holds one directory `<name>/`: the plugin files (tests excluded),
  `lib/shared`, production npm dependencies (no `node_modules/.bin`, no browsers) and a `graphrt-plugin.json`
  whose `checksums` pin every `.mjs`/`.js`/`.cjs`/`.json` file outside `node_modules`. graphrt verifies them on
  install and before every start. `node_modules` is not pinned: npm checked it against the lockfile integrity
  hashes, and hashing all of Playwright before every start would slow every run.
- **Catalog:** `https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/index.json`, with
  `SHA256SUMS` next to it. It is rebuilt from the published tarballs on every publish:
  ```json
  {"schema": 1, "generated_at": "2026-11-18T10:00:00Z", "plugins": [{
    "name": "meta-api", "version": "0.1.0", "description": "...",
    "tarball_url": "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/meta-api-v0.1.0/meta-api-0.1.0.tar.gz",
    "sha256": "<hex of the tarball>", "size_bytes": 29257,
    "permissions": {"network": true, "secrets": true, "env": ["META_ACCESS_TOKEN"]},
    "needs_browser": false, "node": ">=20",
    "nodes": [{"kind": "meta-api.get_page", "title": "...", "description": "..."}], "tools": ["get_page"],
    "readme_url": "https://github.com/BimaPangestu28/graphrt-plugins/blob/meta-api-v0.1.0/meta-api/README.md"}]}
  ```
- **Desktop app:** reads `index.json`, downloads `tarball_url`, checks `sha256` (and `size_bytes`), extracts it
  and installs the `<name>/` directory, for example with `graphrt plugin install <extracted>/<name>`. When
  `needs_browser` is true it then installs Chromium for the bundled Playwright by running
  `node node_modules/playwright/cli.js install chromium` inside the installed plugin directory. Plugin processes
  get a clean environment (only `permissions.env` plus `PATH`, `HOME`, `LANG`, `TMPDIR`), so install Chromium into
  Playwright's default cache under `HOME`, not a custom `PLAYWRIGHT_BROWSERS_PATH`. Plugins with
  `permissions.secrets` need to be trusted (`--trust-plugin <name>`) to receive plaintext secrets.
- **By hand:**
  ```bash
  curl -LO https://github.com/BimaPangestu28/graphrt-plugins/releases/download/meta-api-v0.1.0/meta-api-0.1.0.tar.gz
  curl -L https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/SHA256SUMS | shasum -a 256 -c --ignore-missing
  tar -xzf meta-api-0.1.0.tar.gz
  graphrt plugin install ./meta-api
  ```

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
- **Releases:** `npm run pack:plugins [name...]` builds tarballs, `index.json` and `SHA256SUMS` in `dist/`;
  `npm run verify:plugins dist/*.tar.gz` extracts each one and checks its checksums (add `--graphrt <binary>` to also
  run `graphrt plugin install` into a temporary directory). `npm run publish:plugins` tests, packs and verifies every
  plugin, creates the releases that do not exist yet and refreshes `catalog`; it never changes a published release,
  so bump the version in `definition.mjs` (or `graphrt-plugin.json` for google-maps-scraper) to ship a change.
  `.github/workflows/release.yml` runs the same script on a `<name>-v<version>` tag push or by hand.

Design notes and API research are in `docs/superpowers/`.

## License
Apache-2.0
