# 100+ plugin catalog: design

Date: 2026-11-19 · Status: approved in conversation. The user chose option 1: a declarative generator first, then batches, with complex plugins built individually.

## Intent
Grow the collection by about 110 plugins across AI generation, databases, storage, local media tools, developer tools, collaboration, CRM and marketing, messaging, payments, logistics, web data, Indonesia-specific data and local system tools.

Most of these are thin REST wrappers. Writing each one by hand repeats the same work, so the plan is to build a **declarative REST layer** first, where a plugin is mostly data. Plugins that need protocols, native libraries, signing or local processes stay hand-written and get individual review.

## Phase 1: declarative REST layer (`shared/lib/rest-plugin.mjs`)
`defineRestPlugin(spec)` returns a normal plugin definition, so it works with the existing runner, sync script, manifest and `OPERATIONS.md` generation.

### Plugin-level spec fields
- **Basics:** `name`, `version`, `description`, `extraEnv`, `limits`.
- **`baseUrl`:** a string, or `(environment) => string` that validates env-provided hosts such as region or self-hosted URLs.
- **`auth`, one of:**
  - `{type: "bearer", env}`
  - `{type: "header", header, env, prefix?}`
  - `{type: "query", param, env}` (redacted)
  - `{type: "basic", userEnv, passwordEnv}` or `{type: "basic", tokenEnv, user: "api"}`
  - `{type: "none"}` for public APIs
  - `{type: "custom", authorize}` as the escape hatch
- **`errors`:** declarative mapping, with paths to the message, code and retry hints, a `kindByCode` map, and an optional "error-in-2xx" detector (`okPath`/`okValue` or `errorPath`).
- **`defaultHeaders`, `apiRequest`:** `api_request` defaults to on and stays GET-only for tools; `apiRequest: false` turns it off.

### Operation spec fields
- `name`, `title`, `description`, `method`, `path` (a template such as `/repos/{owner}/{repo}/issues`).
- **`params`:** each param is `{in: "path" | "query" | "body" | "header", type, required, description, enum, min/max, default, wireName?}`.
  - Path params are always encoded with `pathSegment`.
  - Body params can nest with dotted `wireName`s (`"message.text"`), or `bodyMode: "raw"` passes an object through.
- **`write`:** `"read"`, `"idempotent"` (PUT/DELETE or POST reads) or `"unsafe"` (POST create/send).
  - `unsafe` writes never retry after an unknown outcome and carry the "check before retrying" note. POST reads set `idempotent`.
- **`nodeOnly`, `toolPolicy`:** `toolPolicy: "optIn:<ENV>"` refuses tool calls unless the env var is `1`.
- **`response`:** `{dataPath, cursorPath | nextLinkHeader | pagePagination: {pageParam, sizeParam}, offsetPagination}`, used to produce `data` and `next_cursor`. List operations automatically get `limit` and `cursor` mapped to the API's own names.
- **`job` (async generation):**
  - Fields: `{idPath, poll: {method, path, params}, statusPath, doneValues, failedValues, errorPath, resultPath, intervalMs, timeoutMs, wait default true}`.
  - The create request is the unsafe write. Polling reads tolerate transient errors (shared `pollUntilDone`), and a timeout returns the job id with `retryable: false`.
- **`download` (generated media):**
  - Optional `saveTo: {urlPaths, envDir}`. It streams result URLs to `<ENV_DIR>` with the public-https checks (per-hop redirects, private-IP refusal, size cap) from `linkedin-api/lib/public-https-fetch.mjs`, which moves into shared.
  - It returns file paths and keeps the remote URLs.

### Generated tests (`shared/lib/rest-plugin-testing.mjs`)
- `describeRestPluginContract(pluginDefinition, cases)` takes example args per operation and generates request-shape tests (method, path, encoded path params, query, body, auth placement).
- It also generates tests for:
  - redaction of the credential in errors and `api_request` responses;
  - missing required params, and path-traversal attempts in path params;
  - unsafe-write no-retry and tool-policy refusals;
  - `api_request` POST refused for tools;
  - pagination mapping and job polling (done / failed / timeout).
- Every declarative plugin's test file is mostly this call plus a few plugin-specific cases.

### Review gate
Phase 1 gets the full builder → independent review → fix cycle before any batch starts.

## Phase 2: declarative batches (about 8–10 plugins per builder; one reviewer per batch)
Each plugin gets its own README (env, auth, scopes or approvals, pricing warnings, agent policy), an example.yaml with a read operation, and a live check with invalid credentials. A plugin with `auth: none` gets a real read call.

| Batch | Plugins |
|---|---|
| B1 AI image | openai-images, stability-ai, replicate, fal-ai, ideogram, google-imagen |
| B2 AI video | runway, luma-ai, google-veo, replicate-video, kling, minimax-video |
| B3 AI audio | elevenlabs, openai-audio, deepgram, assemblyai, stable-audio |
| B4 AI text and language | openai, anthropic, gemini, groq, mistral, ollama, embeddings (multi-provider), deepl, google-translate, google-vision |
| B5 Developer | github, gitlab, jira, linear, sentry, vercel, cloudflare |
| B6 Collaboration | slack, discord, microsoft-teams, microsoft-graph, gmail-api, google-docs, google-drive |
| B7 Work management | trello, asana, clickup, todoist, zoom, calendly, dropbox, onedrive |
| B8 CRM and marketing | hubspot, salesforce, pipedrive, zoho-crm, mailchimp, brevo, sendgrid, resend, typeform, google-forms, google-analytics |
| B9 Messaging | twilio, vonage, fonnte, wablas, line-messaging |
| B10 Payments and commerce | stripe, midtrans, xendit, paypal, shopify, woocommerce, lazada |
| B11 Logistics and web data | biteship, rajaongkir, shipper, web-search, news-api, wikipedia, coingecko, currency-rates, open-meteo, google-maps-platform |
| B12 Indonesia and vector/HTTP data stores | bmkg, bps, libur-nasional, wilayah-indonesia, supabase, elasticsearch, clickhouse, pinecone, qdrant, weaviate, chroma, neo4j |

### Agent-safety defaults for Phase 2
These follow the rules that earlier reviews settled on:
- **Money movement, refunds, deletes and bulk destructive operations** (e.g. stripe refunds, github repo delete, payment captures, mass email campaigns) are `nodeOnly`.
- **Sends to arbitrary recipients from tools** (email, SMS, WhatsApp gateways, chat posts) need an allowlist env or an opt-in.
- **Paid generation calls** (image, video, audio) are allowed as tools by default. Each README states the pricing, and an optional `<PLUGIN>_TOOL_DAILY_LIMIT` counter (via shared send-guard-like state) is recommended where cheap to add.
- **`api_request`** stays GET-only for tools.

## Phase 3: hand-written plugins (built and reviewed individually or in pairs)
- **Databases with native protocols:** postgres (`pg`), mysql (`mysql2`), sqlite (`node:sqlite` when available, otherwise `better-sqlite3`), mongodb (`mongodb`), redis (`redis`).
  - Read-only by default for tools; writes need a node or opt-in.
  - Parameterised queries only; statement timeouts; row and byte caps.
- **Cloud with request signing:**
  - **s3:** SigV4 shared helper; S3-compatible endpoints for R2 and MinIO.
  - **dynamodb:** SigV4.
  - **bigquery** and **firestore:** Google auth files.
  - **snowflake:** SQL API with key-pair JWT.
- **Files and protocols:** sftp (`ssh2`), local-files (allowlisted directories, realpath checks), rss-reader (XML), youtube-transcript.
- **Local media tools:**
  - ffmpeg (requires the system binary; argument arrays only, no shell; output to an allowlisted dir).
  - image-tools (`sharp`), pdf-tools (`pdf-lib` plus text extraction), excel-csv (`exceljs`/`papaparse`-style), ocr-tesseract (system binary), qr-code.
- **System:**
  - macos-notifications (osascript, JSON stdin).
  - file-watcher.
  - shell-exec: nodeOnly, command allowlist, no shell interpolation, timeouts and output caps.

## Count
- Phase 2: 6 + 6 + 5 + 10 + 7 + 7 + 8 + 11 + 5 + 7 + 10 + 12 = **94**.
- Phase 3: 5 + 5 + 4 + 6 + 3 = **23**.
- **Total: 117 new plugins**, 138 with the existing 21.

## Testing and verification
- Generated contract tests plus plugin-specific tests.
- `npm test` at the root.
- `graphrt plugin info` for each plugin.
- A live call with invalid credentials per plugin, or a real read for public no-auth APIs.
- Nothing is verified with real accounts; each PR says so.

## Delivery
- One PR for Phase 1.
- One PR per Phase 2 batch.
- One PR per Phase 3 plugin or pair.
- Each PR is merged after tests and fixes for the review findings.
