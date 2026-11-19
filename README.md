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
| [state-store](state-store/) | Local state for polling workflows: seen-id sets with TTL (`filter_unseen`), JSON key/values and atomic counters | 11 |
| [computer-control](computer-control/) | Control macOS apps (incl. WhatsApp Desktop) via the Accessibility tree: read UI, click, type, keys, clipboard, screenshots — limited to an app allowlist | 17 |
| [whatsapp-web](whatsapp-web/) | Your personal WhatsApp in the background via a headless WhatsApp Web session: read chats, send messages and files (rate limited) | 7 |
| [whatsapp-api](whatsapp-api/) | WhatsApp Business Cloud API: send text, templates, media and interactive messages, manage templates and the profile | 19 |
| [google-sheets](google-sheets/) | Google Sheets: read ranges, append rows, update and clear cells, find and upsert rows by header (OAuth or service account) | 11 |
| [google-business-profile-api](google-business-profile-api/) | Google Business Profile: locations, hours, reviews and replies, posts and daily performance metrics (API access needs Google approval) | 13 |
| [shopee-api](shopee-api/) | Shopee Open Platform v2 (signed): shop info, products, stock and price, orders and shipping, seller chat | 15 |
| [tiktok-shop-api](tiktok-shop-api/) | TikTok Shop Partner API (signed): shops, products, inventory and price, orders, fulfillment, returns, customer service | 15 |
| [email](email/) | Send email over SMTP and read, flag and move messages over IMAP (Gmail, Outlook or any provider), with a daily send cap | 8 |
| [notion-api](notion-api/) | Notion: search, create pages with simple property values, update properties, query databases (data sources), append paragraphs, comments | 15 |
| [airtable-api](airtable-api/) | Airtable: list bases and schemas, list/find/get records (safely escaped formulas), create, update and upsert records (deletes are node only) | 10 |
| [google-calendar](google-calendar/) | Google Calendar: events with Meet links, free/busy and DST-aware free-slot search, idempotent booking; agent tools limited to allowed calendars (OAuth or service account) | 10 |
| [web-browser](web-browser/) | Read public web pages in a headless browser: readable text or markdown, links, CSS-selector extraction and screenshots; public hosts only (no loopback, private or metadata addresses), robots.txt respected, no clicking or typing | 4 |
| [postgres](postgres/) | PostgreSQL: parameterised queries in database-enforced read-only transactions with timeouts and row/byte caps, writes and DDL (nodes, or agents with an opt-in), tables, columns and plans | 5 |
| [mysql](mysql/) | MySQL and MariaDB: parameterised queries with a server-enforced read-only session and transaction (DDL refused too), timeouts and row/byte caps, writes and DDL (nodes, or agents with an opt-in), tables, columns and plans | 5 |
| [sqlite](sqlite/) | SQLite files in allowed directories (built-in node:sqlite, Node.js 22.13+): parameterised queries on read-only connections, a killable worker per call for timeouts, writes and DDL (nodes, or agents with an opt-in), tables, columns and plans | 5 |
| [mongodb](mongodb/) | MongoDB: find, count, distinct and aggregate with Extended JSON, list databases and collections, insert/update/replace/delete; agent tools read-only unless opted in, never server-side JavaScript | 14 |
| [redis](redis/) | Redis: binary-safe strings, hashes, lists, sets, sorted sets, streams, SCAN and publish with an optional key prefix; agent tools read-only unless opted in, a node-only `command` escape hatch with a denylist | 31 |
| [slack](slack/) | Slack Web API: conversations, history and threads, post/edit messages, reactions, users, file uploads and message search; agent posts need an opt-in, deletes are node only | 18 |
| [discord](discord/) | Discord bot (REST API v10): servers, channels, messages, reactions, members and threads; agent sends need an opt-in, deletes are node only, no pings by default | 21 |
| [microsoft-teams](microsoft-teams/) | Microsoft Teams via Microsoft Graph (delegated OAuth, any tenant): teams, channels, channel messages and replies, chats and members; agent sends need an opt-in | 17 |
| [microsoft-graph](microsoft-graph/) | Microsoft Graph (delegated OAuth, any tenant): Outlook mail list/read/send/drafts/replies, calendar events and users; agent sends need an opt-in and an optional recipient allowlist, deletes are node only | 22 |
| [gmail-api](gmail-api/) | Gmail API: search and read messages and threads, labels, drafts, attachments, and send with safely built MIME (OAuth or service account); agent sends need an opt-in and an optional recipient allowlist | 18 |
| [google-docs](google-docs/) | Google Docs: read documents (with tabs), create, insert text, replace text for templates, raw batch updates behind an opt-in (OAuth or service account) | 6 |
| [google-drive](google-drive/) | Google Drive: search (escaped queries) and list files, export and download to a directory, upload, folders, copy, rename/move, shared drives; sharing, trash and delete are node only (OAuth or service account) | 17 |
| [elevenlabs](elevenlabs/) | ElevenLabs: text to speech and sound effects saved as audio files, Scribe speech to text, voices, models, history and usage (paid per character/minute; cloning and deletes node only) | 12 |
| [openai-audio](openai-audio/) | OpenAI audio: text to speech saved as audio files, transcription (gpt-4o-transcribe, diarize, whisper-1) and translation to English from URLs or an allowlisted folder (paid per minute/character) | 5 |
| [deepgram](deepgram/) | Deepgram: Nova-3 pre-recorded transcription by URL or file (diarization, summaries, redaction), Aura-2 text to speech saved as audio files, text intelligence, models, balances and request history (paid per minute/character) | 10 |
| [assemblyai](assemblyai/) | AssemblyAI: upload audio, transcribe and wait (speakers, PII redaction, audio intelligence; US or EU), sentences, paragraphs, subtitles, word search and LLM Gateway prompts (paid per hour; deletes node only) | 12 |
| [stable-audio](stable-audio/) | Stability AI Stable Audio: music and sound effects from text (2.5, and 3.0 as a job up to 380 s), audio-to-audio and inpainting saved as audio files, credit balance (paid in credits) | 8 |
| [runway](runway/) | Runway API: image, text and video to video, video upscale and text to image as polled tasks with downloads, task status and credits (paid per credit; cancel/delete node only) | 10 |
| [luma-ai](luma-ai/) | Luma AI (current Agents API): Ray 3.2 text/image to video, video edit and reframe, uni-1 images as polled jobs with downloads, credits and usage (paid; deletes node only) | 10 |
| [google-veo](google-veo/) | Google Veo 3.1 GA models on Vertex AI (the Gemini API's Veo previews were shut down): text, image and extend to video as long-running operations, inline video saving, operation status (paid per second; OAuth) | 3 |
| [replicate-video](replicate-video/) | Replicate predictions for video models (Veo, Kling, Hailuo, Wan, ...): run and wait with long time limits and downloads, prediction status, model discovery (paid per model; cancel and webhooks node only) | 13 |
| [kling](kling/) | Kling AI (official API): text, image and omni video with Kling 4.0/3.0/2.x as polled tasks with downloads, task queries and resource packages (paid per second; callbacks node only) | 10 |
| [minimax-video](minimax-video/) | MiniMax video: H3 text/image/reference to video (V2) and Hailuo 2.3 (V1) as polled tasks with downloads, task status and file retrieval (paid; delete and callbacks node only) | 10 |
| [openai-images](openai-images/) | OpenAI Images: generate and edit images with GPT Image and DALL·E (masks, reference images), saved to a local folder (paid per call) | 5 |
| [stability-ai](stability-ai/) | Stability AI Stable Image: generate (Ultra, Core, SD 3.5), upscale (incl. async creative), edit and control images, saved to a local folder (paid in credits) | 19 |
| [replicate](replicate/) | Replicate: run official models, versions and deployments as predictions (waits for the job, downloads outputs), search and browse models (paid per run) | 16 |
| [fal-ai](fal-ai/) | fal.ai: run any fal model through the queue (waits, saves media), check, fetch or cancel requests, search models and prices (paid per run) | 7 |
| [ideogram](ideogram/) | Ideogram: generate (4.5 and 3.0), remix, precise edit, inpaint, reframe, upscale, remove background and describe images, with free dry-run price quotes (paid per image) | 12 |
| [google-imagen](google-imagen/) | Google image generation via the Gemini Interactions API (Nano Banana models; Imagen itself is shut down): generate, multi-turn and multi-image edits, saved to a local folder (paid per image) | 8 |
| [openai](openai/) | OpenAI API for a second model: Responses and chat completions (non-streaming), embeddings, moderation, models, files and the Batch API (paid calls never retried; batches and mcp tools opt-in for agents; deletes and cancels node only) | 18 |
| [anthropic](anthropic/) | Claude API (version 2026-10-21) for a second model: messages (non-streaming), token counting, models, files and Message Batches with parsed JSONL results (deletes and cancels are node only) | 15 |
| [gemini](gemini/) | Google Gemini API for a second model: generateContent (non-streaming), countTokens, embeddings, models and the Files API with resumable upload (`delete_file` is node only) | 11 |
| [groq](groq/) | Groq API (fast open models): chat completions (non-streaming), Whisper transcription and translation, text to speech, models, files and batches (deletes and cancels are node only) | 16 |
| [mistral](mistral/) | Mistral AI API: chat and FIM completions (non-streaming), embeddings, moderation, OCR of PDFs and images to markdown, models, files and batch jobs (deletes and cancels are node only) | 18 |
| [ollama](ollama/) | Local Ollama server (`OLLAMA_URL` defaults to localhost, optional `OLLAMA_API_KEY` for proxies): generate, chat and embed (non-streaming), list and show models; pull, copy and delete are node only | 11 |
| [embeddings](embeddings/) | Provider-agnostic text embeddings over the OpenAI-compatible `/embeddings` API (OpenAI, Mistral, Gemini, Voyage, Ollama or a custom host, chosen by env) plus `rank_by_similarity` for semantic search with scores | 2 |
| [deepl](deepl/) | DeepL API (Free and Pro): translate and rephrase text, translate documents, usage, languages and glossaries (read) | 11 |
| [google-translate](google-translate/) | Google Cloud Translation Basic (v2) with an API key in a header: translate text, detect language, list languages | 4 |
| [google-vision](google-vision/) | Google Cloud Vision with an API key: OCR, labels, faces, safe search and any feature mix for an image URL (downloaded by the plugin), `gs://` URI or allowed local file, plus batch pass-throughs for images and one PDF; billed calls never retried | 7 |
| [github](github/) | GitHub REST API (2026-03-10): repos, issues, pull requests, contents, code/issue search, releases, Actions runs, notifications; agent writes opt-in, merges/commits/releases node only | 33 |
| [gitlab](gitlab/) | GitLab REST API v4 on gitlab.com or self-hosted (`GITLAB_BASE_URL`): projects, issues, merge requests, pipelines, repository files; agent writes opt-in, merges/commits node only, CI variables never reachable by tools | 28 |
| [jira](jira/) | Jira Cloud REST API v3: JQL search (enhanced `search/jql`), issues, assign, transitions, comments (plain text converted to ADF), projects and issue types; site validated to `*.atlassian.net`, agent writes opt-in | 16 |
| [linear](linear/) | Linear GraphQL API with fixed query documents: issues (list with filters, search, create, update), comments, projects, teams, workflow states, users; agent writes opt-in, delete node only | 16 |
| [sentry](sentry/) | Sentry (sentry.io, us/de region): organizations, projects, releases, issues and events with stack traces; resolve, ignore (archive) and assign are agent opt-in, delete node only | 14 |
| [vercel](vercel/) | Vercel REST API: deployments (list, inspect, build logs, cancel), projects, domains and DNS config check; environment variables, redeploys and deletes node only, secrets unreachable by agent tools | 21 |
| [cloudflare](cloudflare/) | Cloudflare API v4: accounts, zones, DNS records (agent create/update only for allowlisted names, delete node only), cache purge (node only), Workers with settings and deployments | 15 |
| [s3](s3/) | Amazon S3 and S3-compatible storage (R2, MinIO) with built-in SigV4: list buckets and objects, metadata, downloads into an allowed directory, uploads, copies; agent tools read-only unless opted in, delete and presigned URLs node only | 8 |
| [dynamodb](dynamodb/) | Amazon DynamoDB with built-in SigV4: list and describe tables, get, query, scan and batch-get with plain JSON or typed values, put/update (agents opt-in) and delete (node only) | 9 |
| [bigquery](bigquery/) | Google BigQuery: datasets, tables and schemas, parameterised GoogleSQL with a bytes-billed cap on every query, free dry runs and paged typed results; agent tools run SELECT only (dry-run checked) unless opted in | 5 |
| [firestore](firestore/) | Google Cloud Firestore: get, list and query documents (filters, ordering, collection groups) with plain JSON or typed values, create and update (agents opt-in), delete (node only) | 6 |
| [snowflake](snowflake/) | Snowflake SQL API with key-pair JWT auth: statements with bindings, async polling and cancel, typed rows across result partitions; agent tools read-only (statement check, dedicated role) unless opted in | 4 |
| [trello](trello/) | Trello: boards, lists, cards, comments, checklists, labels and members; agent writes only on boards in an allowlist, deletes node only | 23 |
| [asana](asana/) | Asana: workspaces, projects, sections, tasks (list, search, create, update, complete, subtasks) and comments with a personal access token; agent tools assign only to me or user gids, deletes node only | 20 |
| [clickup](clickup/) | ClickUp: workspaces, spaces, folders, lists, tasks (list, filter across a workspace, get, create, update), comments and time entries (read); task deletes are node only | 19 |
| [todoist](todoist/) | Todoist API v1: projects, sections, tasks (filter, completed, create, Quick Add, update, move, complete, reopen), labels and comments; token fields stripped, deletes node only | 22 |
| [zoom](zoom/) | Zoom (Server-to-Server OAuth): users, meetings (list, get, create, update; delete is node only), past meetings, instances and participants, cloud recordings; start links, recording links and passcodes hidden from agents | 14 |
| [calendly](calendly/) | Calendly: current user, event types and open times, scheduled events and invitees, availability and busy times; single-use links and bookings are agent opt-in, cancel is node only | 16 |
| [dropbox](dropbox/) | Dropbox: account, list and search files, metadata, download to a directory, upload up to 150 MB, folders, move/copy (agents: opt-in plus a path allowlist); delete, shared and temporary links node only | 17 |
| [onedrive](onedrive/) | OneDrive via Microsoft Graph: browse, get by path, search, download to a directory, upload up to 250 MB, folders, rename/move/copy (agents: folder allowlist); sharing links, invites and deletes node only; download URLs never shown to agents | 17 |
| [twilio](twilio/) | Twilio: send SMS/MMS and WhatsApp (paid), list and read messages and calls, outbound calls (node only), free and paid Lookup v2, balance; agent sends need an opt-in and an E.164 recipient allowlist | 13 |
| [vonage](vonage/) | Vonage Messages API: SMS and WhatsApp text, image, templates and custom messages (paid), Number Insight (paid levels opt-in for agents) and balance; agent sends need an opt-in and an exact-number E.164 recipient allowlist | 7 |
| [fonnte](fonnte/) | Fonnte WhatsApp gateway (Indonesia): send messages and files to one number, validate numbers, device status and quota, groups; agent sends need an opt-in and an E.164 recipient allowlist, group sends and device actions are node only | 8 |
| [wablas](wablas/) | Wablas WhatsApp gateway (Indonesia, per-account *.wablas.com server): send text, images, documents and videos to one number, message reports, cancel, device info and quota; agent sends need an opt-in and an E.164 recipient allowlist | 8 |
| [line-messaging](line-messaging/) | LINE Messaging API: push and reply messages (with retry keys), multicast and broadcast (node only), profiles, followers, groups and quota; agent pushes need an opt-in and a recipient id allowlist | 16 |
| [telegram-bot](telegram-bot/) | Telegram Bot API: read updates by long polling, send messages, photos and documents, edit and delete messages, answer button presses, manage the webhook | 16 |
| [open-meteo](open-meteo/) | Open-Meteo weather (no API key): place search for coordinates and forecasts with current, hourly and daily values; the reference [declarative plugin](docs/declarative-plugins.md) | 3 |

- **Node and tool:** every API operation is a workflow node (`<plugin>.<operation>`) and an agent tool (`<operation>`).
  The exceptions are node only, so an LLM can never call them: token refresh (tokens never reach an LLM) and
  high-risk writes such as marketplace price/stock/shipping changes and WhatsApp Desktop sends.
- **`api_request` for agents is read-only:** an agent calling `api_request` as a tool may only use GET; writes
  through it must be a workflow node or a dedicated operation.
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
    "needs_browser": false, "node": ">=20", "warning": null, "operations_count": 25,
    "nodes": [{"kind": "meta-api.get_page", "title": "...", "description": "...",
      "config_schema": {"type": "object", "properties": {"page_id": {"type": "string"}}},
      "outputs": [{"name": "data", "type": "any", "description": "API result"}]}],
    "tools": ["get_page"],
    "readme_url": "https://github.com/BimaPangestu28/graphrt-plugins/blob/meta-api-v0.1.0/meta-api/README.md"}]}
  ```
  Each node carries its `config_schema` (the manifest's JSON Schema, verbatim) and `outputs` (when the manifest
  declares them), so a builder can write correct steps for a plugin that is not installed yet. `warning` is the
  first `> **Warning:**` blockquote of the shipped README as one line (the Terms of Service warning of
  `whatsapp-web` and `google-maps-scraper`), else `null`; `operations_count` is the number of nodes. These fields
  were added within `schema: 1`: readers that do not know them ignore them.
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
  `npm run publish:plugins -- --catalog-only` only rebuilds `index.json` and `SHA256SUMS` from the published tarballs
  (after a catalog format change); it refuses to drop a plugin or change any version, `sha256` or `size_bytes`.
  `.github/workflows/release.yml` runs the same script on a `<name>-v<version>` tag push or by hand.

Design notes and API research are in `docs/superpowers/`.

## License
Apache-2.0
