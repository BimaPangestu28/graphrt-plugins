# graphrt-plugins

## Overview
A collection of plugins for [graphrt](https://github.com/BimaPangestu28/graphrt). Each directory is one plugin with
its own `graphrt-plugin.json`, and it can be installed on its own.

## Plugins
| Plugin | Status | ToS risk | What it does | Operations |
|--------|--------|----------|--------------|-----------:|
| [google-maps-scraper](google-maps-scraper/) | experimental | **high** | Searches Google Maps with a headless browser and extracts business phone numbers (free, no API key) | 1 |
| [meta-api](meta-api/) | beta | low | Facebook Page posts and comments, Instagram publishing and comments, Messenger and Instagram Direct | 25 |
| [threads-api](threads-api/) | beta | low | Threads profile, publishing, replies, moderation, mentions and search | 16 |
| [x-api](x-api/) | beta | medium | X posts, replies, likes, reposts, DMs and media upload (X bills per request) | 21 |
| [youtube-api](youtube-api/) | beta | low | YouTube channel, videos, comments, moderation and live chat | 15 |
| [linkedin-api](linkedin-api/) | beta | **high** | LinkedIn posts, images, comments and reactions for members and organizations | 15 |
| [tiktok-api](tiktok-api/) | experimental | medium | TikTok profile, videos and publishing, plus comments and DMs via the Business API | 19 |
| [state-store](state-store/) | stable | none | Local state for polling workflows: seen-id sets with TTL (`filter_unseen`), JSON key/values and atomic counters | 11 |
| [computer-control](computer-control/) | experimental | medium | Control macOS apps (incl. WhatsApp Desktop) via the Accessibility tree: read UI, click, type, keys, clipboard, screenshots — limited to an app allowlist | 17 |
| [whatsapp-web](whatsapp-web/) | experimental | **high** | Your personal WhatsApp in the background via a headless WhatsApp Web session: read chats, send messages and files (rate limited) | 7 |
| [whatsapp-api](whatsapp-api/) | beta | low | WhatsApp Business Cloud API: send text, templates, media and interactive messages, manage templates and the profile | 19 |
| [google-sheets](google-sheets/) | beta | none | Google Sheets: read ranges, append rows, update and clear cells, find and upsert rows by header (OAuth or service account) | 11 |
| [google-business-profile-api](google-business-profile-api/) | beta | low | Google Business Profile: locations, hours, reviews and replies, posts and daily performance metrics (API access needs Google approval) | 13 |
| [shopee-api](shopee-api/) | experimental | low | Shopee Open Platform v2 (signed): shop info, products, stock and price, orders and shipping, seller chat | 15 |
| [tiktok-shop-api](tiktok-shop-api/) | experimental | low | TikTok Shop Partner API (signed): shops, products, inventory and price, orders, fulfillment, returns, customer service | 15 |
| [email](email/) | beta | low | Send email over SMTP and read, flag and move messages over IMAP (Gmail, Outlook or any provider), with a daily send cap | 8 |
| [notion-api](notion-api/) | beta | none | Notion: search, create pages with simple property values, update properties, query databases (data sources), append paragraphs, comments | 15 |
| [airtable-api](airtable-api/) | beta | none | Airtable: list bases and schemas, list/find/get records (safely escaped formulas), create, update and upsert records (deletes are node only) | 10 |
| [google-calendar](google-calendar/) | beta | none | Google Calendar: events with Meet links, free/busy and DST-aware free-slot search, idempotent booking; agent tools limited to allowed calendars (OAuth or service account) | 10 |
| [web-browser](web-browser/) | stable | low | Read public web pages in a headless browser: readable text or markdown, links, CSS-selector extraction and screenshots; public hosts only (no loopback, private or metadata addresses), robots.txt respected, no clicking or typing | 4 |
| [postgres](postgres/) | stable | none | PostgreSQL: parameterised queries in database-enforced read-only transactions with timeouts and row/byte caps, writes and DDL (nodes, or agents with an opt-in), tables, columns and plans | 5 |
| [mysql](mysql/) | stable | none | MySQL and MariaDB: parameterised queries with a server-enforced read-only session and transaction (DDL refused too), timeouts and row/byte caps, writes and DDL (nodes, or agents with an opt-in), tables, columns and plans | 5 |
| [sqlite](sqlite/) | stable | none | SQLite files in allowed directories (built-in node:sqlite, Node.js 22.13+): parameterised queries on read-only connections, a killable worker per call for timeouts, writes and DDL (nodes, or agents with an opt-in), tables, columns and plans | 5 |
| [mongodb](mongodb/) | stable | none | MongoDB: find, count, distinct and aggregate with Extended JSON, list databases and collections, insert/update/replace/delete; agent tools read-only unless opted in, never server-side JavaScript | 14 |
| [redis](redis/) | stable | none | Redis: binary-safe strings, hashes, lists, sets, sorted sets, streams, SCAN and publish with an optional key prefix; agent tools read-only unless opted in, a node-only `command` escape hatch with a denylist | 31 |
| [slack](slack/) | beta | low | Slack Web API: conversations, history and threads, post/edit messages, reactions, users, file uploads and message search; agent posts need an opt-in, deletes are node only | 18 |
| [discord](discord/) | beta | low | Discord bot (REST API v10): servers, channels, messages, reactions, members and threads; agent sends need an opt-in, deletes are node only, no pings by default | 21 |
| [microsoft-teams](microsoft-teams/) | beta | low | Microsoft Teams via Microsoft Graph (delegated OAuth, any tenant): teams, channels, channel messages and replies, chats and members; agent sends need an opt-in | 17 |
| [microsoft-graph](microsoft-graph/) | beta | low | Microsoft Graph (delegated OAuth, any tenant): Outlook mail list/read/send/drafts/replies, calendar events and users; agent sends need an opt-in and an optional recipient allowlist, deletes are node only | 22 |
| [gmail-api](gmail-api/) | beta | low | Gmail API: search and read messages and threads, labels, drafts, attachments, and send with safely built MIME (OAuth or service account); agent sends need an opt-in and an optional recipient allowlist | 18 |
| [google-docs](google-docs/) | beta | none | Google Docs: read documents (with tabs), create, insert text, replace text for templates, raw batch updates behind an opt-in (OAuth or service account) | 6 |
| [google-drive](google-drive/) | beta | none | Google Drive: search (escaped queries) and list files, export and download to a directory, upload, folders, copy, rename/move, shared drives; sharing, trash and delete are node only (OAuth or service account) | 17 |
| [elevenlabs](elevenlabs/) | beta | none | ElevenLabs: text to speech and sound effects saved as audio files, Scribe speech to text, voices, models, history and usage (paid per character/minute; cloning and deletes node only) | 12 |
| [openai-audio](openai-audio/) | beta | none | OpenAI audio: text to speech saved as audio files, transcription (gpt-4o-transcribe, diarize, whisper-1) and translation to English from URLs or an allowlisted folder (paid per minute/character) | 5 |
| [deepgram](deepgram/) | beta | none | Deepgram: Nova-3 pre-recorded transcription by URL or file (diarization, summaries, redaction), Aura-2 text to speech saved as audio files, text intelligence, models, balances and request history (paid per minute/character) | 10 |
| [assemblyai](assemblyai/) | beta | none | AssemblyAI: upload audio, transcribe and wait (speakers, PII redaction, audio intelligence; US or EU), sentences, paragraphs, subtitles, word search and LLM Gateway prompts (paid per hour; deletes node only) | 12 |
| [stable-audio](stable-audio/) | beta | none | Stability AI Stable Audio: music and sound effects from text (2.5, and 3.0 as a job up to 380 s), audio-to-audio and inpainting saved as audio files, credit balance (paid in credits) | 8 |
| [runway](runway/) | beta | none | Runway API: image, text and video to video, video upscale and text to image as polled tasks with downloads, task status and credits (paid per credit; cancel/delete node only) | 10 |
| [luma-ai](luma-ai/) | beta | none | Luma AI (current Agents API): Ray 3.2 text/image to video, video edit and reframe, uni-1 images as polled jobs with downloads, credits and usage (paid; deletes node only) | 10 |
| [google-veo](google-veo/) | beta | none | Google Veo 3.1 GA models on Vertex AI (the Gemini API's Veo previews were shut down): text, image and extend to video as long-running operations, inline video saving, operation status (paid per second; OAuth) | 3 |
| [replicate-video](replicate-video/) | beta | none | Replicate predictions for video models (Veo, Kling, Hailuo, Wan, ...): run and wait with long time limits and downloads, prediction status, model discovery (paid per model; cancel and webhooks node only) | 13 |
| [kling](kling/) | beta | none | Kling AI (official API): text, image and omni video with Kling 4.0/3.0/2.x as polled tasks with downloads, task queries and resource packages (paid per second; callbacks node only) | 10 |
| [minimax-video](minimax-video/) | beta | none | MiniMax video: H3 text/image/reference to video (V2) and Hailuo 2.3 (V1) as polled tasks with downloads, task status and file retrieval (paid; delete and callbacks node only) | 10 |
| [openai-images](openai-images/) | beta | none | OpenAI Images: generate and edit images with GPT Image and DALL·E (masks, reference images), saved to a local folder (paid per call) | 5 |
| [stability-ai](stability-ai/) | beta | none | Stability AI Stable Image: generate (Ultra, Core, SD 3.5), upscale (incl. async creative), edit and control images, saved to a local folder (paid in credits) | 19 |
| [replicate](replicate/) | beta | none | Replicate: run official models, versions and deployments as predictions (waits for the job, downloads outputs), search and browse models (paid per run) | 16 |
| [fal-ai](fal-ai/) | beta | none | fal.ai: run any fal model through the queue (waits, saves media), check, fetch or cancel requests, search models and prices (paid per run) | 7 |
| [ideogram](ideogram/) | beta | none | Ideogram: generate (4.5 and 3.0), remix, precise edit, inpaint, reframe, upscale, remove background and describe images, with free dry-run price quotes (paid per image) | 12 |
| [google-imagen](google-imagen/) | beta | none | Google image generation via the Gemini Interactions API (Nano Banana models; Imagen itself is shut down): generate, multi-turn and multi-image edits, saved to a local folder (paid per image) | 8 |
| [openai](openai/) | beta | none | OpenAI API for a second model: Responses and chat completions (non-streaming), embeddings, moderation, models, files and the Batch API (paid calls never retried; batches and mcp tools opt-in for agents; deletes and cancels node only) | 18 |
| [anthropic](anthropic/) | beta | none | Claude API (version 2026-10-21) for a second model: messages (non-streaming), token counting, models, files and Message Batches with parsed JSONL results (deletes and cancels are node only) | 15 |
| [gemini](gemini/) | beta | none | Google Gemini API for a second model: generateContent (non-streaming), countTokens, embeddings, models and the Files API with resumable upload (`delete_file` is node only) | 11 |
| [groq](groq/) | beta | none | Groq API (fast open models): chat completions (non-streaming), Whisper transcription and translation, text to speech, models, files and batches (deletes and cancels are node only) | 16 |
| [mistral](mistral/) | beta | none | Mistral AI API: chat and FIM completions (non-streaming), embeddings, moderation, OCR of PDFs and images to markdown, models, files and batch jobs (deletes and cancels are node only) | 18 |
| [ollama](ollama/) | beta | none | Local Ollama server (`OLLAMA_URL` defaults to localhost, optional `OLLAMA_API_KEY` for proxies): generate, chat and embed (non-streaming), list and show models; pull, copy and delete are node only | 11 |
| [embeddings](embeddings/) | beta | none | Provider-agnostic text embeddings over the OpenAI-compatible `/embeddings` API (OpenAI, Mistral, Gemini, Voyage, Ollama or a custom host, chosen by env) plus `rank_by_similarity` for semantic search with scores | 2 |
| [deepl](deepl/) | beta | none | DeepL API (Free and Pro): translate and rephrase text, translate documents, usage, languages and glossaries (read) | 11 |
| [google-translate](google-translate/) | beta | none | Google Cloud Translation Basic (v2) with an API key in a header: translate text, detect language, list languages | 4 |
| [google-vision](google-vision/) | beta | none | Google Cloud Vision with an API key: OCR, labels, faces, safe search and any feature mix for an image URL (downloaded by the plugin), `gs://` URI or allowed local file, plus batch pass-throughs for images and one PDF; billed calls never retried | 7 |
| [github](github/) | beta | none | GitHub REST API (2026-03-10): repos, issues, pull requests, contents, code/issue search, releases, Actions runs, notifications; agent writes opt-in, merges/commits/releases node only | 33 |
| [gitlab](gitlab/) | beta | none | GitLab REST API v4 on gitlab.com or self-hosted (`GITLAB_BASE_URL`): projects, issues, merge requests, pipelines, repository files; agent writes opt-in, merges/commits node only, CI variables never reachable by tools | 28 |
| [jira](jira/) | beta | none | Jira Cloud REST API v3: JQL search (enhanced `search/jql`), issues, assign, transitions, comments (plain text converted to ADF), projects and issue types; site validated to `*.atlassian.net`, agent writes opt-in | 16 |
| [linear](linear/) | beta | none | Linear GraphQL API with fixed query documents: issues (list with filters, search, create, update), comments, projects, teams, workflow states, users; agent writes opt-in, delete node only | 16 |
| [sentry](sentry/) | beta | none | Sentry (sentry.io, us/de region): organizations, projects, releases, issues and events with stack traces; resolve, ignore (archive) and assign are agent opt-in, delete node only | 14 |
| [vercel](vercel/) | beta | none | Vercel REST API: deployments (list, inspect, build logs, cancel), projects, domains and DNS config check; environment variables, redeploys and deletes node only, secrets unreachable by agent tools | 21 |
| [cloudflare](cloudflare/) | beta | none | Cloudflare API v4: accounts, zones, DNS records (agent create/update only for allowlisted names, delete node only), cache purge (node only), Workers with settings and deployments | 15 |
| [s3](s3/) | beta | none | Amazon S3 and S3-compatible storage (R2, MinIO) with built-in SigV4: list buckets and objects, metadata, downloads into an allowed directory, uploads, copies; agent tools read-only unless opted in, delete and presigned URLs node only | 8 |
| [dynamodb](dynamodb/) | beta | none | Amazon DynamoDB with built-in SigV4: list and describe tables, get, query, scan and batch-get with plain JSON or typed values, put/update (agents opt-in) and delete (node only) | 9 |
| [bigquery](bigquery/) | beta | none | Google BigQuery: datasets, tables and schemas, parameterised GoogleSQL with a bytes-billed cap on every query, free dry runs and paged typed results; agent tools run SELECT only (dry-run checked) unless opted in | 5 |
| [firestore](firestore/) | beta | none | Google Cloud Firestore: get, list and query documents (filters, ordering, collection groups) with plain JSON or typed values, create and update (agents opt-in), delete (node only) | 6 |
| [snowflake](snowflake/) | beta | none | Snowflake SQL API with key-pair JWT auth: statements with bindings, async polling and cancel, typed rows across result partitions; agent tools read-only (statement check, dedicated role) unless opted in | 4 |
| [trello](trello/) | beta | none | Trello: boards, lists, cards, comments, checklists, labels and members; agent writes only on boards in an allowlist, deletes node only | 23 |
| [asana](asana/) | beta | none | Asana: workspaces, projects, sections, tasks (list, search, create, update, complete, subtasks) and comments with a personal access token; agent tools assign only to me or user gids, deletes node only | 20 |
| [clickup](clickup/) | beta | none | ClickUp: workspaces, spaces, folders, lists, tasks (list, filter across a workspace, get, create, update), comments and time entries (read); task deletes are node only | 19 |
| [todoist](todoist/) | beta | none | Todoist API v1: projects, sections, tasks (filter, completed, create, Quick Add, update, move, complete, reopen), labels and comments; token fields stripped, deletes node only | 22 |
| [zoom](zoom/) | beta | none | Zoom (Server-to-Server OAuth): users, meetings (list, get, create, update; delete is node only), past meetings, instances and participants, cloud recordings; start links, recording links and passcodes hidden from agents | 14 |
| [calendly](calendly/) | beta | none | Calendly: current user, event types and open times, scheduled events and invitees, availability and busy times; single-use links and bookings are agent opt-in, cancel is node only | 16 |
| [dropbox](dropbox/) | beta | none | Dropbox: account, list and search files, metadata, download to a directory, upload up to 150 MB, folders, move/copy (agents: opt-in plus a path allowlist); delete, shared and temporary links node only | 17 |
| [onedrive](onedrive/) | beta | none | OneDrive via Microsoft Graph: browse, get by path, search, download to a directory, upload up to 250 MB, folders, rename/move/copy (agents: folder allowlist); sharing links, invites and deletes node only; download URLs never shown to agents | 17 |
| [twilio](twilio/) | beta | low | Twilio: send SMS/MMS and WhatsApp (paid), list and read messages and calls, outbound calls (node only), free and paid Lookup v2, balance; agent sends need an opt-in and an E.164 recipient allowlist | 13 |
| [vonage](vonage/) | beta | low | Vonage Messages API: SMS and WhatsApp text, image, templates and custom messages (paid), Number Insight (paid levels opt-in for agents) and balance; agent sends need an opt-in and an exact-number E.164 recipient allowlist | 7 |
| [fonnte](fonnte/) | experimental | **high** | Fonnte WhatsApp gateway (Indonesia): send messages and files to one number, validate numbers, device status and quota, groups; agent sends need an opt-in and an E.164 recipient allowlist, group sends and device actions are node only | 8 |
| [wablas](wablas/) | experimental | **high** | Wablas WhatsApp gateway (Indonesia, per-account *.wablas.com server): send text, images, documents and videos to one number, message reports, cancel, device info and quota; agent sends need an opt-in and an E.164 recipient allowlist | 8 |
| [line-messaging](line-messaging/) | beta | low | LINE Messaging API: push and reply messages (with retry keys), multicast and broadcast (node only), profiles, followers, groups and quota; agent pushes need an opt-in and a recipient id allowlist | 16 |
| [ffmpeg](ffmpeg/) | stable | none | Local media with the system ffmpeg: probe, convert (fixed format/codec/quality presets), trim, extract audio, thumbnails, resize, join, burn subtitles and GIFs; files in allowed directories only, protocol and demuxer whitelists, new output files only | 9 |
| [image-tools](image-tools/) | stable | none | Local images with sharp: metadata, resize, crop, rotate, convert (jpeg/png/webp/avif), compress, text or image watermarks and thumbnails; raster formats recognised by content, a decoded-pixel cap against decompression bombs, new output files only | 8 |
| [pdf-tools](pdf-tools/) | stable | none | Local PDFs with pdf-lib and pdfjs-dist: page count and metadata, text extraction, merge, extract or split pages, rotate, text watermark and images to PDF; parsing in a killable, heap-capped worker, page caps, new output files only | 8 |
| [excel-csv](excel-csv/) | stable | none | Local CSV/TSV and XLSX files: list sheets, read rows (sheet, A1 range, header row, row cap; formulas as values), write and convert; CSV-injection protection (only nodes may turn it off), zip-bomb check, new output files only | 4 |
| [ocr-tesseract](ocr-tesseract/) | stable | none | OCR with the system Tesseract: text, hOCR or TSV from images or PDF pages (via poppler's pdftoppm) in allowed directories, installed-language and page-segmentation choices; inputs checked by content, argument arrays, timeouts | 2 |
| [qr-code](qr-code/) | stable | none | QR codes: generate PNG or SVG files (error correction, size, colours) and decode QR/Micro QR codes from local images (zxing-wasm loaded from node_modules, never a CDN); pixel cap, new output files only | 2 |
| [hubspot](hubspot/) | beta | none | HubSpot CRM (API 2026-09, private app token): contacts, companies, deals, tickets and other objects (list, get, search, create, update), associations, timeline notes, properties, pipelines, owners; archiving and association removal are node only, agent api_request limited to CRM read paths | 15 |
| [salesforce](salesforce/) | beta | none | Salesforce REST API (one org, refresh-token or client-credentials OAuth): SOQL queries with batch paging, SOSL search, records get/create/update/upsert by external id, describe, limits, updated/deleted ids; deletes are node only | 17 |
| [zoho-crm](zoho-crm/) | beta | none | Zoho CRM API v8 (any data center, auto-refreshed OAuth): list, get, search and COQL-query records, related records, insert/update/upsert (no workflow triggers by default), modules, fields, users; deletes are node only | 15 |
| [mailchimp](mailchimp/) | beta | low | Mailchimp Marketing API: audiences, members and tags by email (subscriber hash computed), member search, campaigns, content and reports; agent member writes need an opt-in, campaign send/schedule and member deletes are node only | 23 |
| [brevo](brevo/) | beta | low | Brevo API v3: contacts and lists, transactional email with templates and delivery events, campaigns; agent sends need an opt-in and an optional recipient allowlist, contact writes an opt-in, deletes and campaign sends are node only | 19 |
| [sendgrid](sendgrid/) | beta | low | Twilio SendGrid v3: send email from simple fields or dynamic templates (global or EU host), templates, global stats, suppression lists and unsubscribe groups; agent sends need an opt-in and an optional recipient allowlist, raw sends are node only | 12 |
| [resend](resend/) | beta | low | Resend: send email with Idempotency-Key retries (html/text or templates, scheduling, tags), sent emails, reschedule, domains with DNS records; agent sends need an opt-in and an optional recipient allowlist, batch sends and cancel are node only | 9 |
| [typeform](typeform/) | beta | none | Typeform: forms, responses with filters and token paging, insights and workspaces (US/EU data centers); form creation behind an opt-in, deletes node only, agent api_request limited to read paths | 11 |
| [google-forms](google-forms/) | beta | none | Google Forms: read forms and responses (paged, timestamp filters), create forms, batch edits and publish/close behind opt-ins, Pub/Sub watches node only (OAuth or service account) | 11 |
| [google-analytics](google-analytics/) | beta | none | Google Analytics 4 (read-only): reports with plain dimension/metric names, realtime, pivot and batch reports, metadata and compatibility, accounts, properties and data streams (OAuth or service account) | 11 |
| [pipedrive](pipedrive/) | beta | none | Pipedrive CRM (API v2/v1, API token, optional company domain): persons, organizations, deals and activities (list, get, search, create, update), pipelines, stages and notes; deletes are node only, agent api_request limited to CRM read paths | 32 |
| [biteship](biteship/) | beta | none | Biteship Indonesian shipping: courier rates, couriers, area search, order tracking and public waybill tracking; booking and cancelling orders node only | 10 |
| [rajaongkir](rajaongkir/) | beta | none | RajaOngkir by Komerce (current API): Indonesian shipping cost quotes (domestic, by district, international), destination search and waybill tracking | 11 |
| [shipper](shipper/) | beta | none | Shipper.id logistics API v3: locations, domestic rates, orders with tracking and labels; creating and cancelling orders and pickups node only | 15 |
| [web-search](web-search/) | beta | low | Provider-agnostic web and news search through Tavily, Brave Search or SerpAPI (provider and key from env; paid per query, never retried after an unknown outcome) | 2 |
| [news-api](news-api/) | beta | none | NewsAPI.org: search news articles and blogs, top headlines by country, category or source, and news sources | 4 |
| [wikipedia](wikipedia/) | stable | none | Wikipedia in any language (no API key): search, page summaries, plain-text content (capped), media lists, nearby pages and language links | 7 |
| [coingecko](coingecko/) | stable | none | CoinGecko crypto data (public, Demo or Pro key): prices, ranked markets, coin details, market charts, OHLC, search, trending, categories and global stats | 15 |
| [currency-rates](currency-rates/) | stable | none | Exchange rates from Frankfurter (ECB and other central banks, no API key): latest, historical, time series, pair rates and amount conversion | 9 |
| [google-maps-platform](google-maps-platform/) | beta | none | Google Maps Platform (billed per call; cheap default field masks, never retried after an unknown outcome): Places (New) text and nearby search, details, autocomplete, photos; Geocoding v4; Routes routes and matrices (agent matrices capped) | 9 |
| [stripe](stripe/) | beta | none | Stripe API: customers, PaymentIntents, payment links, draft invoices, products and prices, charges, balance, subscriptions; agent PaymentIntents capped by amount and currency, confirm/capture/refund/finalize node only | 35 |
| [midtrans](midtrans/) | beta | none | Midtrans (sandbox/production): Snap payment pages (agent use capped by amount) and Core API transaction status; cancel, expire, refund, approve/deny and capture node only | 11 |
| [xendit](xendit/) | beta | none | Xendit: invoices (hosted payment pages; agent use capped by amount and currency), payment requests v3, balance, transactions; refunds, payouts and invoice expiry node only | 13 |
| [paypal](paypal/) | beta | none | PayPal REST (sandbox/live): orders (agent use capped by amount and currency), captures, refunds, draft invoices, balances and transactions; capture, refunds, invoice sending and payouts node only | 19 |
| [shopify](shopify/) | beta | none | Shopify Admin GraphQL (2026-10): shop, products, orders, customers, locations and inventory levels; product writes agent opt-in, inventory adjustments, order edits, refunds and cancellations node only | 15 |
| [woocommerce](woocommerce/) | beta | none | WooCommerce REST v3 (https store): products, variations, orders, customers; product updates and on-hold status agent opt-in (no prices, stock, completion, cancels or refunds), refunds node only | 12 |
| [lazada](lazada/) | experimental | low | Lazada Open Platform (signed, regional gateway): seller, products, orders and order items; price, stock, pack and ready-to-ship node only | 12 |
| [bmkg](bmkg/) | stable | none | BMKG open data (no API key): latest, M5.0+ and felt earthquakes with shakemaps, 3-day village weather forecasts by adm4 code, nowcast weather warnings (credit BMKG as the source) | 7 |
| [libur-nasional](libur-nasional/) | stable | none | Indonesian public holidays and cuti bersama (2011 to next year, cached): list, check a date, next holidays, working-day counts (no API key) | 5 |
| [bps](bps/) | beta | none | BPS (Statistics Indonesia) Web API: domains, subjects, variables and dynamic data, static tables, strategic indicators, export/import, press releases, publications, search, glossary and KBLI/KBKI (free API key) | 22 |
| [wilayah-indonesia](wilayah-indonesia/) | stable | none | Indonesian administrative regions with Kemendagri codes: provinces, regencies/cities, districts and villages, parent lookups with full addresses and name search (no API key, cached dataset) | 6 |
| [supabase](supabase/) | beta | none | Supabase Data API (PostgREST) and Storage: select rows with safely quoted structured filters, insert/upsert/update and RPC (agents opt-in), file list/download/upload; deletes and signed URLs node only | 16 |
| [clickhouse](clickhouse/) | beta | none | ClickHouse HTTP interface: read-only parameterised queries (readonly=1, time and result caps), databases, tables and columns, JSONEachRow inserts (agents opt-in); DDL/DROP via a node-only execute | 8 |
| [elasticsearch](elasticsearch/) | beta | none | Elasticsearch: Query DSL search, count and ES\|QL, get/multi-get documents, cluster health, indices and mappings (ApiKey or basic); agent writes need an opt-in, deletes and bulk are node only, system indices are off limits for agents | 16 |
| [neo4j](neo4j/) | beta | none | Neo4j Cypher over the HTTP Query API v2: read queries in read transactions with an agent statement guard (no LOAD CSV/APOC/dbms), schema, nodes by elementId; writes need an opt-in for agents, deletes are node only | 11 |
| [weaviate](weaviate/) | beta | none | Weaviate: near-text, vector, hybrid and BM25 search with filters (GraphQL built from validated arguments), counts, objects and schema; agent writes and raw GraphQL need opt-ins, deletes are node only | 14 |
| [pinecone](pinecone/) | beta | none | Pinecone vector database (API 2026-07): indexes, stats, namespaces, query/fetch/list vectors, document search on validated *.pinecone.io index hosts; agent upserts need an opt-in, deletes are node only | 21 |
| [qdrant](qdrant/) | beta | none | Qdrant (Cloud or self-hosted): collections, universal query (vector, hybrid, recommend, groups), scroll, retrieve, count, facets; agent writes need an opt-in, deletes are node only | 17 |
| [chroma](chroma/) | beta | none | Chroma HTTP API v2 (local or Chroma Cloud, one database per config): collections, get/query/search records; agent adds and upserts need an opt-in, deletes are node only | 16 |
| [local-files](local-files/) | stable | none | Local files in allowed directories: list, stat, read (UTF-8 or base64, capped with `truncated`), search by name glob or plain-text content, and staged writes that never overwrite unless a node asks; realpath checks, no FIFOs/devices/hard links, agent writes opt-in, deletes node only | 7 |
| [rss-reader](rss-reader/) | stable | none | RSS 2.0, RSS 1.0, Atom and JSON Feed: fetch from public https URLs (redirect hops checked, size cap) or parse given text into one normalised item shape, with `since` and item limits; strict XML parser without DTDs or entity expansion | 2 |
| [youtube-transcript](youtube-transcript/) | beta | low | YouTube captions via the official Data API only: list a video's caption tracks and download one as timed segments and text (videos the account can edit; no scraping, see its README), or parse VTT/SRT you already have | 3 |
| [sftp](sftp/) | beta | none | SFTP (ssh2) with a pinned host key and env-only, redacted credentials: list, stat and read remote files inside `SFTP_ROOT`, download to an allowed local directory, staged uploads that never overwrite unless a node asks; agent writes opt-in, deletes node only, timeouts | 7 |
| [macos-notifications](macos-notifications/) | stable | none | Local macOS notifications (title, subtitle, message, system sound) via `/usr/bin/osascript` with a constant script and the text as separate arguments (no script injection); agent calls rate limited | 1 |
| [file-watcher](file-watcher/) | stable | none | Notice added, modified and removed files in allowed directories by polling: snapshot to a self-contained cursor, list changes since a cursor, or wait up to 5 minutes for the next change; bounded, read-only, never follows symlinks | 3 |
| [shell-exec](shell-exec/) | stable | none | **Dangerous:** run allowlisted local executables with argument arrays (never a shell) in allowed directories, with a clean environment, timeouts that kill the whole process group, output caps and secret redaction; for workflow nodes, agents only for exact paths and argument patterns allowed by `SHELL_EXEC_TOOL_RULES` | 1 |
| [google-search-console](google-search-console/) | beta | none | Google Search Console API v1: search analytics (clicks, impressions, CTR, position by query/page/country/device/date, row paging), URL inspection, sites and sitemaps (OAuth or service account; read scope unless writing); sitemap submit and site add agent opt-in, removals node only | 11 |
| [hunter](hunter/) | beta | medium | Hunter.io API v2 (key in header): domain search, email finder and verifier, person/company enrichment (credits; never retried after an unknown outcome), free email count, company discovery and account, leads and leads lists; agent lead writes need an opt-in, deletes node only, agent api_request limited to free read paths | 19 |
| [apollo](apollo/) | beta | medium | Apollo.io API: People API Search (free) and organization search, person and company enrichment (credits; never retried after an unknown outcome), contacts, accounts and sequences; agent bulk enrichment and contact writes need opt-ins, sequence enrolment and webhook enrichment node only, agent api_request limited to CRM read paths | 18 |
| [zerobounce](zerobounce/) | beta | low | ZeroBounce email validation API v2 (default, US or EU host; key redacted): validate one address (credits; never retried after an unknown outcome), batches of up to 100 (agent opt-in), credits and usage; bulk file upload, status, result download and delete node only with file directory allowlists | 9 |
| [qontak](qontak/) | experimental | low | Mekari Qontak (Mekari API HMAC or bearer tokens): WhatsApp template sends (agent opt-in + exact E.164 recipient allowlist, never retried), templates, channels, rooms and broadcast logs; CRM contacts, companies, deals, tasks, notes and pipelines (agent writes opt-in, deletes node only) | 39 |
| [meta-ads](meta-ads/) | beta | low | Meta Marketing API: ad accounts, campaigns, ad sets, ads, creatives, insights and async reports, Lead Ads forms and leads (opt-in); agent pause/activate and capped budget changes after opt-in, creates and deletes node only | 22 |
| [tiktok-ads](tiktok-ads/) | beta | low | TikTok API for Business (Marketing API v1.3): advertiser info, campaigns, ad groups, ads, integrated reports, Instant Form leads (opt-in); agent enable/disable and capped budget changes after opt-in, creates and deletes node only | 22 |
| [google-ads](google-ads/) | beta | low | Google Ads API v26 (REST, OAuth or service account): accessible customers, GAQL search and searchStream (SELECT only), campaign/keyword/search-term reports; agent pause/enable and capped budget changes after opt-in, other mutates node only | 16 |
| [telegram-bot](telegram-bot/) | beta | low | Telegram Bot API: read updates by long polling, send messages, photos and documents, edit and delete messages, answer button presses, manage the webhook | 16 |
| [open-meteo](open-meteo/) | stable | none | Open-Meteo weather (no API key): place search for coordinates and forecasts with current, hourly and daily values; the reference [declarative plugin](docs/declarative-plugins.md) | 3 |

- **Node and tool:** every API operation is a workflow node (`<plugin>.<operation>`) and an agent tool (`<operation>`).
  The exceptions are node only, so an LLM can never call them: token refresh (tokens never reach an LLM) and
  high-risk writes such as marketplace price/stock/shipping changes and WhatsApp Desktop sends.
- **`api_request` for agents is read-only:** an agent calling `api_request` as a tool may only use GET; writes
  through it must be a workflow node or a dedicated operation.
- **Operation lists:** each plugin's full list is in its `OPERATIONS.md`, and its setup (tokens, permissions,
  platform limits) is in its `README.md`.

## Plugin status
Every plugin has a maturity label and a Terms-of-Service risk rating in [`plugin-status.json`](plugin-status.json),
with the reason for each. The table above, the status line in each plugin README and the release catalog
(`index.json`: `status`, `status_reason`, `tos_risk`) all come from that file.

| Status | Meaning |
|--------|---------|
| `stable` | Verified end to end with real use: local plugins whose live run exercised the real behaviour, public no-auth APIs read live, and database clients run against real servers |
| `beta` | Official API, reviewed and unit-tested with fakes, but checked live only with invalid credentials (no real account yet). Most plugins are here |
| `experimental` | Unofficial or reverse-engineered access, scraping, automation that risks the account, or important parts (such as request signing) not yet verified against the live service |

| ToS risk | Meaning |
|----------|---------|
| `none` | Used as the provider intends under its standard developer terms |
| `low` | Official API, but its content, messaging, spam or personal-data rules can be broken by careless use |
| `medium` | The provider's automation or data-protection rules restrict what agents commonly do with it; read the notes |
| `high` | The access itself is against the provider's terms, or its terms forbid the automation the plugin enables: accounts can be banned. The README has a warning and names the official alternative |

The sources and mitigations behind each rating are in [docs/tos-audit.md](docs/tos-audit.md). Edit
`plugin-status.json`, then run `npm run sync` to update the READMEs; `npm test` fails when they are out of date.

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
- **Catalog:** the `catalog` release, rebuilt from the published tarballs on every publish, holds two indexes
  (both compact JSON) plus `SHA256SUMS`, which lists every tarball, icon, detail file and both indexes.
  - **v2 (current):** `https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/index-v2.json`, a
    slim index for plugin lists (about 340 KB for 146 plugins; publishing warns above 1 MiB and refuses above 4 MiB):
    ```json
    {"schema": 2, "generated_at": "2026-11-21T10:00:00Z", "plugins": [{
      "name": "meta-api", "display_name": "Facebook & Instagram", "version": "0.1.0", "description": "...",
      "icon_url": "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/icon-meta-api-<12 hex>.svg",
      "tarball_url": "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/meta-api-v0.1.0/meta-api-0.1.0.tar.gz",
      "sha256": "<hex of the tarball>", "size_bytes": 29257,
      "permissions": {"network": true, "secrets": true, "env": ["META_ACCESS_TOKEN"]},
      "needs_browser": false, "node": ">=20", "warning": null,
      "status": "beta", "status_reason": "...", "tos_risk": "low",
      "source": "official", "publisher": "graphrt",
      "repository_url": "https://github.com/BimaPangestu28/graphrt-plugins/tree/meta-api-v0.1.0/meta-api",
      "operations_count": 25, "tools": ["get_page"], "node_kinds": [{"kind": "meta-api.get_page", "title": "Get page"}],
      "readme_url": "https://github.com/BimaPangestu28/graphrt-plugins/blob/meta-api-v0.1.0/meta-api/README.md",
      "detail_url": "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/plugin-meta-api-0.1.0.json",
      "detail_sha256": "<hex of the detail file>", "detail_size_bytes": 23849}]}
    ```
    Each entry links the **detail file** of its version, `plugin-<name>-<version>.json` (at most 1 MiB):
    ```json
    {"schema": 2, "name": "meta-api", "version": "0.1.0",
     "nodes": [{"kind": "meta-api.get_page", "title": "...", "description": "...",
       "config_schema": {"type": "object", "properties": {"page_id": {"type": "string"}}},
       "outputs": [{"name": "data", "type": "any", "description": "API result"}]}],
     "tools": [{"name": "get_page", "description": "..."}]}
    ```
    A detail file derives only from the released manifest of that version, so it is **immutable**: it is uploaded
    once, before either index, and a publish that would give an existing detail file other bytes fails. Readers
    verify `detail_sha256` and can cache it forever under `<name>-<version>`.
  - **v1 (older apps):** `https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/index.json`,
    `schema: 1`, the same entries with `nodes` instead of `node_kinds`/`detail_*`:
    ```json
    {"schema": 1, "generated_at": "2026-11-18T10:00:00Z", "plugins": [{
      "name": "meta-api", "version": "0.1.0", "...": "the v2 list fields up to operations_count",
      "nodes": [{"kind": "meta-api.get_page", "title": "...", "description": "...",
        "config_schema": {"type": "object", "properties": {"page_id": {"type": "string"}}},
        "outputs": [{"name": "data", "type": "any", "description": "API result"}]}],
      "tools": ["get_page"],
      "readme_url": "https://github.com/BimaPangestu28/graphrt-plugins/blob/meta-api-v0.1.0/meta-api/README.md"}]}
    ```
    v1 must fit the desktop app's 2 MiB limit (`MAX_CATALOG_BYTES`). While it fits it is published in full; when
    it would not, it is published without the nodes' `config_schema` and `outputs` (v1 readers treat both as
    optional) and the publish logs a warning.

  In both, a node's `config_schema` is the manifest's JSON Schema, verbatim, and `outputs` appears when the manifest
  declares them, so a builder can write correct steps for a plugin that is not installed yet. `warning` is the
  first `> **Warning:**` blockquote of the shipped README as one line (the Terms of Service warning of
  `whatsapp-web` and `google-maps-scraper`), else `null`; `operations_count` is the number of nodes. `icon_url` is
  the plugin's `icon.svg`, a 24×24 SVG published as an asset of the `catalog` release under a name that contains
  its sha256 prefix, so the URL is immutable (see [docs/icons.md](docs/icons.md)). `source` is `"official"` (built
  from this repo; `publisher` `"graphrt"`, `repository_url` the plugin's directory at its release tag) or
  `"community"` (a reviewed third-party plugin from [community-plugins.json](community-plugins.json); `publisher`
  and `repository_url` are its developer's, and its tarball is mirrored to a `community-<name>-v<version>` release
  of this repo, see [docs/community-plugins.md](docs/community-plugins.md)); readers treat a missing `source` as
  `"official"`. Fields added within a schema are optional: readers that do not know them ignore them.

  **Asset limit and pruning:** a GitHub release holds at most 1000 assets. Old icons and detail files are kept so
  that older indexes keep resolving, so the `catalog` release grows with every icon change and plugin version
  (about 300 assets today). Publishing warns from 900 assets and refuses above 1000. To prune, delete by hand
  (`gh release delete-asset catalog <name>`) the `icon-*.svg` and `plugin-*.json` assets that the live
  `index.json` and `index-v2.json` no longer reference; never delete one they reference.
- **Desktop app:** reads `index-v2.json` (falling back to `index.json` when it is missing or has an unknown
  `schema`), fetches a plugin's detail file when it needs node schemas, downloads `tarball_url`, checks `sha256` (and `size_bytes`), extracts it
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
  `graphrt-plugin.json` and `OPERATIONS.md` from `definition.mjs`, and writes the labels from `plugin-status.json` into
  the READMEs. Never edit those generated files (or the README status lines) by hand.
- **Tests:** `npm test` runs every suite and fails when the generated files are out of date.
- **Icons:** `npm run icons` regenerates each `<plugin>/icon.svg` from `icons.json` (needs `npm ci` at the root);
  see [docs/icons.md](docs/icons.md).
- **Releases:** `npm run pack:plugins [name...]` builds tarballs, `index.json`, `index-v2.json`, detail files
  (`details/`), icons (`icons/`) and `SHA256SUMS` in `dist/`;
  `npm run verify:plugins dist/*.tar.gz` extracts each one and checks its checksums (add `--graphrt <binary>` to also
  run `graphrt plugin install` into a temporary directory). `npm run publish:plugins` tests, packs and verifies every
  plugin, creates the releases that do not exist yet and refreshes `catalog`; it never changes a published release,
  so bump the version in `definition.mjs` (or `graphrt-plugin.json` for google-maps-scraper) to ship a change.
  `npm run publish:plugins -- --catalog-only` only rebuilds `index.json`, `index-v2.json`, the detail files and
  `SHA256SUMS` from the published tarballs and uploads new icons and detail files (after a catalog format, status or
  icon change); it refuses to drop a plugin or change any version, `sha256` or `size_bytes`, and to replace a
  published detail file with other bytes.
  `.github/workflows/release.yml` runs the same script on a `<name>-v<version>` tag push or by hand.
  Every publish (including `--catalog-only`, which uses only already-mirrored tarballs) also lists the
  [community plugins](docs/community-plugins.md); one that fails a check is skipped with its reason, never failing
  the publish. `node scripts/verify-plugins.mjs --community <name>` runs those checks for one registry entry.

### Multi-user agents
Plugins whose credential belongs to one end user (GitHub, GitLab, Slack, Notion, Google Workspace, Microsoft 365,
Zoom, Salesforce, HubSpot, LinkedIn, Meta, TikTok, the ads APIs and others; see each README's "Per-user tokens" section) accept
`<PLUGIN>_TOOL_TOKEN_SOURCE=context`. Agent tools then act with the end user's own token, which graphrt passes per call
from the `agent` node's `tool_context` as `access_token`, and never with the plugin's env credential; a call without
one is refused. Workflow nodes keep using the env. Supabase has its own `SUPABASE_TOOL_MODE=user_rpc`. Details:
[docs/declarative-plugins.md](docs/declarative-plugins.md#per-user-tool-tokens-toolusertoken).

Want to add a plugin? Read [CONTRIBUTING.md](CONTRIBUTING.md). Design notes and API research are in `docs/superpowers/`.

## License
Apache-2.0

Plugin icons are brand marks from [Simple Icons](https://simpleicons.org) (CC0) and glyphs from
[Lucide](https://lucide.dev) (ISC, see [LICENSES/lucide.txt](LICENSES/lucide.txt)). Brand names and marks belong to
their owners and are used only to identify the service each plugin integrates with; see [docs/icons.md](docs/icons.md).
