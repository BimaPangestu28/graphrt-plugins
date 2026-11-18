# Social media API plugins — Design

Date: 2026-11-18 · Status: approved (approach and order approved in conversation; the user asked for autonomous execution)

## Intent
Add graphrt plugins that drive the official APIs of Meta (Facebook Page, Instagram, Messenger/IG Direct), Threads, X, YouTube, LinkedIn and TikTok. They should read and post comments, send DMs, publish and manage posts, and read profiles: everything each official API allows for an account the user owns. Agents and workflows can then run social media work.

## Goals
- One self-contained plugin per platform: `meta-api`, `threads-api`, `x-api`, `youtube-api`, `linkedin-api` and `tiktok-api`.
- Every operation is both a node (`<plugin>.<operation>`) and a tool (`<operation>`).
- The plugins cover the posts, comments/replies, DMs (where the API has them) and profile endpoints listed below. Each plugin also gets a generic `api_request` operation for any other endpoint on that API's origin, so "all API support" also covers endpoints that have no dedicated operation.
- Errors are clear and stable (`auth_error`, `permission_denied`, `rate_limited`, …) and never contain tokens.

## Non-goals
- Running the OAuth login flow in the plugin. The user supplies tokens.
- Webhooks or real-time triggers. graphrt plugins are request-driven, so new-comment detection is done by polling from a workflow.
- Ads, insights and analytics beyond what `api_request` reaches.

## Anti-goals
- A tool argument that lets an LLM choose credentials.
- Retrying a non-idempotent write on 5xx or a network error, which could double-post.
- Sending a token to any origin other than the platform's API.

## Constraints
- graphrt plugin = one directory with `graphrt-plugin.json`, `runtime: process`, JSON-RPC over stdio. stdout is reserved for the protocol.
- The process gets a clean environment: only `permissions.env` variables reach it.
- Node >= 20 (needs `AbortSignal.any`). No npm dependencies; uses built-in `fetch`.
- Installed per directory, so shared code is copied into each plugin.

## Approaches
1. **One self-contained plugin per platform, built from a shared library (chosen).** Install, tokens and permissions are separate per platform, and a crash stays isolated. The cost is a copy of `shared/lib` in each plugin, kept in sync by a script and checked by `npm test`.
2. A single `social` plugin. Rejected: it mixes all tokens in one process, makes for a large plugin, and couples platforms that fail independently.
3. Example workflows on graphrt's built-in HTTP node only. Rejected: users would have to know every endpoint, there is no error mapping, and it isn't usable as agent tools.

## Design

### Shared library (`shared/lib`, copied to `<plugin>/lib/shared`)
- `api-client.mjs`, `createApiClient({baseUrl, authorize, parseError, fetchImpl, maxRetries, timeoutMs, defaultHeaders})`:
  - Builds URLs; arrays in the query string are joined with commas.
  - Encodes JSON or form bodies.
  - Accepts absolute URLs only on the base origin (used for pagination links).
  - Retries 429 for every method, and 5xx or network errors only for GET/HEAD/PUT/DELETE. Honours `Retry-After` and waits at most 60 s.
  - Has a per-attempt timeout and supports cancellation.
  - Maps HTTP status to an error kind; a platform `parseError` can override it. Tokens are redacted from messages.
- `params.mjs`, `validateArguments(schema, args)`: handles defaults, required fields, types, enum, min/max, minLength and maxItems. It coerces template strings (`"5"`, `"true"`, `"[...]"`), drops empty optional values and ignores unknown keys.
- `operations.mjs`:
  - `buildDescriptors`, `buildManifest`, `createOperationRunner` and `startPlugin`.
  - Nodes get an optional `access_token` config field that overrides the token. Tools always use the env token.
  - Node outputs are `data` (any) and `next_cursor` (string or null).
- `testing.mjs`, `createRecordingFetch(responses)`: a test double for fetch.
- `scripts/sync-shared.mjs` copies the library and regenerates each manifest from `definition.mjs`. `--check` fails when anything is stale.
- Root `npm test` runs that check plus every plugin's tests.

### Plugin layout
```
<plugin>/
  definition.mjs      # name, version, tokenEnv, extraEnv, createClient, operations
  operations/*.mjs    # operation definitions grouped by area
  lib/client.mjs      # platform client: base URL, auth, parseError, cursor helpers
  lib/shared/         # synced copy (do not edit)
  plugin.mjs          # startPlugin(pluginDefinition)
  graphrt-plugin.json # generated
  example.yaml, README.md, package.json, test/
```

### Platforms and operations
List operations take `limit` and `cursor` and return `next_cursor`. Every plugin also has `api_request {method, path, query?, body?}` restricted to its API origin.

**meta-api**
- Env: `META_ACCESS_TOKEN` (Page token), `META_PAGE_ID`, `META_IG_USER_ID`, `META_GRAPH_VERSION` (default `v26.0`).
- Page: `get_page`, `list_page_posts`, `create_page_post` (message, link, published, scheduled_publish_time), `create_page_photo_post` (url, message), `update_page_post`, `delete_page_post`.
- Facebook comments: `list_comments` (object_id, filter, order), `reply_to_comment` (object_id, message, attachment_url), `set_comment_hidden`, `delete_comment`, `like_comment`, `unlike_comment`.
- Instagram:
  - `get_instagram_account`, `list_instagram_media`, `get_instagram_publishing_limit`.
  - `publish_instagram_media` (IMAGE, VIDEO/REELS, STORIES or CAROUSEL from public URLs). It creates the container, polls `status_code` every 5 s for up to 5 min, then calls `media_publish`.
  - `list_instagram_comments`, `list_instagram_comment_replies`, `reply_to_instagram_comment`, `set_instagram_comment_hidden`, `delete_instagram_comment`.
- Messaging: `list_conversations` (platform messenger|instagram, user_id), `list_conversation_messages`, `send_message` (recipient_id, text or attachment_url+attachment_type, messaging_type RESPONSE|UPDATE|MESSAGE_TAG, tag HUMAN_AGENT).
- Errors: codes 4, 17, 32, 341, 613, 80001–80009 → `rate_limited`; 190/102 → `auth_error`; 10 and 200–299 → `permission_denied`. `estimated_time_to_regain_access` → `retryAfterMs`.

**threads-api**
- Env: `THREADS_ACCESS_TOKEN`. Base `https://graph.threads.net/v1.0`.
- `get_profile`, `lookup_profile`, `list_threads`, `list_my_replies`.
- `publish_thread`: TEXT, IMAGE, VIDEO or CAROUSEL, plus reply_to_id, quote_post_id, reply_control, poll options, link_attachment, topic_tag and alt_text. Same flow as Instagram: container, poll status, publish.
- `repost_thread`, `delete_thread`, `list_replies` (with a `conversation` flag that switches to `/conversation`), `hide_reply`, `list_pending_replies`, `approve_pending_reply`, `list_mentions`, `keyword_search`, `get_publishing_limit`, `refresh_access_token`.
- No DM API exists.

**x-api**
- Env: `X_ACCESS_TOKEN` (OAuth2 user token), `X_USER_ID` (optional; resolved via `/2/users/me` when missing). Base `https://api.x.com`.
- Users and posts: `get_me`, `get_user_by_username`, `create_post` (text, reply_to_post_id, quote_post_id, media_ids, poll_options, poll_duration_minutes, reply_settings), `delete_post`, `get_post`, `list_user_posts`, `list_mentions`, `search_recent_posts`.
- Replies and engagement: `list_replies` (search `conversation_id:`), `hide_reply`, `like_post`, `unlike_post`, `repost`, `undo_repost`.
- DMs: `list_dm_events`, `list_dm_conversation_events` (conversation_id or participant_id), `send_dm` (participant_id or conversation_id, text, media_id), `create_group_dm`.
- `upload_media` (image from a URL).
- `refresh_access_token` (client_id + refresh_token arguments; returns new tokens, because X rotates refresh tokens).
- Read operations take `query_params` for field and expansion parameters, since the live field names (`tweet.fields` vs `post.fields`) are unverified.
- The README notes that X charges per request.

**youtube-api**
- Env: `YOUTUBE_ACCESS_TOKEN`, or the refresh trio `YOUTUBE_REFRESH_TOKEN` + `YOUTUBE_CLIENT_ID` + `YOUTUBE_CLIENT_SECRET`. With the trio the plugin fetches and caches an access token and refreshes once on a 401. Base `https://www.googleapis.com/youtube/v3`.
- Channel and videos: `get_my_channel`, `list_my_videos` (uploads playlist), `get_videos`, `update_video_metadata` (reads the current snippet and merges it, so nothing is cleared), `delete_video`.
- Comments: `list_comment_threads` (video_id or channel, order, search_terms, moderation_status), `list_comment_replies`, `post_comment`, `reply_to_comment`, `update_comment`, `delete_comment`, `set_comment_moderation_status` (heldForReview|published|rejected, ban_author).
- Live chat: `list_live_chat_messages`, `send_live_chat_message`.
- No DM API exists. `quotaExceeded` → `rate_limited` and is not retried (resets daily).

**linkedin-api**
- Env: `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_AUTHOR_URN` (optional default author), `LINKEDIN_VERSION` (default `202611`). Base `https://api.linkedin.com/rest`, with headers `Linkedin-Version` and `X-Restli-Protocol-Version: 2.0.0`.
- Posts: `get_userinfo` (`/v2/userinfo`; returns `person_urn`), `create_post` (author, text, visibility, article fields or image_urn; returns the URN from `x-restli-id`), `get_post`, `list_organization_posts`, `update_post`, `delete_post`, `upload_image` (from a URL: initializeUpload, then PUT).
- Comments and reactions: `list_comments` (target_urn: post or comment), `create_comment` (target_urn, text, actor, parent_comment_urn), `update_comment`, `delete_comment`, `add_reaction`, `remove_reaction`, `list_reactions`.
- No DM API for normal apps. The README covers the Community Management API approval that organization operations need.

**tiktok-api**
- Env: `TIKTOK_ACCESS_TOKEN` for the Open API (Bearer), and optionally `TIKTOK_BUSINESS_ACCESS_TOKEN` + `TIKTOK_BUSINESS_ID` for the Business API (`Access-Token` header) used for comments and DMs.
- Open API (`https://open.tiktokapis.com`):
  - `get_user_info`, `list_videos`, `query_videos`, `get_creator_info`.
  - `publish_video` (PULL_FROM_URL; direct post or inbox draft), `publish_photos` (PULL_FROM_URL; direct post or media upload), `get_publish_status`.
  - `refresh_access_token` (returns the rotated tokens).
- Business API (`https://business-api.tiktok.com/open_api/v1.3`):
  - Comments: `list_comments`, `list_comment_replies`, `create_comment`, `reply_to_comment`, `set_comment_hidden`, `set_comment_liked`, `delete_comment`.
  - Messages: `list_conversations`, `list_messages`, `send_message`.
  - The Business API field names come from a third-party client, so the README marks them as needing live verification. Messaging access is restricted (regions, approval, 48 h reply window).
- Errors: the Open API returns `error.code != "ok"` (HTTP 200 included) and the Business API `code != 0`; both become PluginErrors. `api_request` takes `api: open|business`.

### Testing
- Shared: unit tests for validation, the client (URL, auth, bodies, origin guard, error kinds, retry rules, cancel, redaction) and the runner.
- Per plugin: table-driven tests. Each operation runs against `createRecordingFetch`, and the test asserts the method, path, key query/body fields, and the `data`/`next_cursor` mapping. The tests also cover the platform `parseError` mapping and multi-step flows (publish polling, ID resolution, token refresh).
- Live testing happens only when the user sets tokens. Otherwise this is reported as not live-verified.

### Delivery
One branch and PR per plugin. Shared code goes in with the first plugin, `meta-api`. The order is meta, threads, x, youtube, linkedin, tiktok. Each PR is merged after tests pass.

## Left to the builder
- Exact default `fields` lists, polling intervals within the stated bounds, and how operations are grouped across files.
