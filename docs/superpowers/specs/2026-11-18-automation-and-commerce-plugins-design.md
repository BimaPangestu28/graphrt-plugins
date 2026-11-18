# Automation and commerce plugins: design

Date: 2026-11-18 · Status: approved in conversation. The user agreed to the list and asked for autonomous execution.

## Intent
These plugins round out the collection for automation and commerce:
- A **state store**, so polling workflows (new comments, DMs, orders) never handle the same item twice.
- More messaging channels: **Telegram** and **email**.
- A shared data sink: **Google Sheets**.
- **Google Business Profile**: reviews and posts for Maps listings, which pairs with google-maps-scraper.
- Indonesian marketplaces: **Shopee** and **TikTok Shop**.

## Common rules
Same as `2026-11-18-social-api-plugins-design.md`:
- one self-contained directory per plugin;
- `definition.mjs`, `operations/` and `lib/`, built on the shared runner (`npm run sync`);
- every operation is a node and a tool, except `nodeOnly` ones (token refresh, anything that returns credentials);
- table-driven tests with fakes, plus a live check using an invalid credential only.

Local plugins use `localOnly: true` and `resolveAccessToken: () => "local"`.

## state-store (local)
- **Storage:**
  - One JSON file per namespace in `STATE_STORE_DIR` (default `~/.graphrt/state-store`).
  - Writes are atomic (write to a temp file, then rename) and serialised in-process.
  - A per-namespace lock file guards against other processes; a stale lock is taken over when its pid is dead.
  - Namespaces match `^[a-z0-9][a-z0-9_.-]{0,63}$`.
- **Seen ids:**
  - `filter_unseen(namespace, ids[], mark=true)` returns `new_ids` and, when `mark` is true, marks them seen in the same atomic step.
  - Also `mark_seen`, `is_seen`, `forget_seen`.
  - Seen ids expire after `ttl_days` (default 90).
  - At most 100k ids per namespace; the oldest are dropped first.
- **Key/value:** `get`, `set` (JSON value, optional `ttl_seconds`), `delete`, `list_keys` (prefix), `increment` (atomic counter).
- **Housekeeping:** `clear_namespace` (node-only), `list_namespaces`.
- **Limits:** values ≤ 1 MB, file ≤ 50 MB. Over a limit → `invalid_input`.

## telegram-bot
- **Env:** `TELEGRAM_BOT_TOKEN`. Base `https://api.telegram.org/bot<token>`. The token sits in the URL path, so it must be redacted everywhere: return it from `authorize`.
- **Updates:** `get_updates` (offset, limit, timeout ≤ 25, allowed_updates). `next_cursor` is `last update_id + 1`. Combine it with state-store or pass the cursor back.
- **Sending:** `send_message` (chat_id, text, parse_mode, reply_to_message_id, disable_notification, reply_markup), `send_photo` / `send_document` (URL or file_id), `send_chat_action`.
- **Editing:** `edit_message_text`, `delete_message`, `forward_message`, `answer_callback_query`.
- **Info:** `get_me`, `get_chat`, `get_chat_member_count`.
- **Webhook:** `set_webhook`, `delete_webhook`, `get_webhook_info`. Node-only: they change bot routing.
- **Errors and retries:**
  - `{ok:false, error_code, description, parameters.retry_after}`.
  - 429 → `rate_limited` with `retryAfterMs`.
  - 401 → `auth_error`; 403 (bot blocked) → `permission_denied`.
  - Sends are POSTs, so they are never retried after an unknown outcome.
- **Also:** `api_request` restricted to Bot API methods (`/method` paths).

## email (SMTP send, IMAP read)
- **Dependencies:** `nodemailer` (SMTP) and `imapflow` (IMAP). The README covers `npm install`.
- **Env:**
  - SMTP: `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT` (default 465), `EMAIL_SMTP_SECURE` (default true), `EMAIL_SMTP_USER`.
  - IMAP: `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT` (default 993).
  - Shared: `EMAIL_PASSWORD` (app password), `EMAIL_FROM`.
  - Gmail and Outlook presets are documented.
- **Sending:**
  - `send_email` (to/cc/bcc, subject, text, html, reply_to, in_reply_to/references for threading, attachments from https URLs or allowed local dirs in `EMAIL_ALLOWED_FILE_DIRS`).
  - Limits: at most 50 recipients per message; daily cap `EMAIL_DAILY_SEND_LIMIT` (default 200), persisted locally.
- **Reading:**
  - `list_messages` (mailbox, unseen_only, since, from, subject contains, limit; newest first; returns uid, from, to, subject, date, flags, snippet).
  - `read_message` (uid → text, html sanitised to text, attachment metadata).
  - `mark_seen` / `mark_unseen`, `move_message`, `list_mailboxes`.
- **Safety:** html is never executed; attachment downloads are not exposed to tools.
- **Errors:** auth → `auth_error`; connection → `network_error`; sends are never retried.

## google-sheets
- **Auth:** either the OAuth refresh trio (`GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), cached and refreshed on 401 as in youtube-api, or a service account `GOOGLE_SERVICE_ACCOUNT_JSON` (path to the key file; JWT RS256 with `node:crypto`).
- **Scope:** `https://www.googleapis.com/auth/spreadsheets`. Base `https://sheets.googleapis.com/v4`.
- **Spreadsheet:** `get_spreadsheet` (metadata, sheet list), `create_spreadsheet`, `add_sheet`.
- **Values:** `read_range`, `batch_read`, `append_rows` (valueInputOption USER_ENTERED|RAW, insertDataOption INSERT_ROWS), `update_range`, `clear_range`.
- **Records:** `find_rows` (first row is the header, simple equals/contains filters done client-side), `upsert_row` (matched by a key column).
- **Also:** `api_request`.
- **Notes:**
  - Append is a POST, so it is never retried after an unknown outcome.
  - A1 ranges are validated loosely and sheet names are quoted correctly.

## google-business-profile-api
- **Auth:** the same Google auth options as google-sheets. Scope `https://www.googleapis.com/auth/business.manage`. API access must be approved by Google; the README says so.
- **Accounts and locations:**
  - `list_accounts` (Account Management API v1).
  - `list_locations` and `get_location` (Business Information API v1, `readMask`).
  - `update_location` (`updateMask`, limited to description, phone and hours, regular and special).
- **Reviews:** `list_reviews`, `get_review`, `reply_to_review` (PUT `.../reviews/{id}/reply`), `delete_review_reply`. These use the My Business API v4 reviews endpoints, which are still the official way to manage reviews.
- **Posts:** `list_local_posts`, `create_local_post` (STANDARD/EVENT/OFFER, summary, call to action, media URL), `delete_local_post` (v4 localPosts).
- **Performance:** `get_daily_metrics` (Business Profile Performance API).
- **Also:** `api_request`, restricted to the Google Business Profile hosts it uses. It needs one client per host, so `api_request` takes a `host` selector.

## shopee-api (Shopee Open Platform v2)
- **Env:** `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_SHOP_ID`, `SHOPEE_ACCESS_TOKEN`, `SHOPEE_REFRESH_TOKEN`, `SHOPEE_ENV` (`live`|`test`).
  - Live host: `partner.shopeemobile.com`.
  - Test host: `partner.test-stable.shopeemobile.com`.
- **Signing:** HMAC-SHA256 over `partner_id + path + timestamp + access_token + shop_id`, using `partner_key`. Query parameters: `partner_id`, `timestamp`, `access_token`, `shop_id`, `sign`.
  - Signing is implemented in `lib/` and tested against a known vector computed independently in the test.
  - `partner_key` and `access_token` are redacted.
- **Shop and products:** `get_shop_info`, `get_item_list`, `get_item_base_info`, `update_stock`, `update_price`.
- **Orders:** `get_order_list` (time range ≤ 15 days, order_status), `get_order_detail`, `ship_order` / `get_shipping_parameter`, `get_tracking_number`.
- **Chat:** `sellerchat_get_conversation_list`, `sellerchat_get_message`, `sellerchat_send_message`. These need Shopee's chat permission; the README says so.
- **Token:** `refresh_access_token` (node-only; returns the rotated tokens).
- **Errors and retries:**
  - Body `{error, message, request_id}`, where a non-empty `error` means failure, even with HTTP 200.
  - Map `error_auth`/`invalid_access_token` → `auth_error`, `error_param` → `invalid_input`, and `error_too_many_requests`/`rate_limit` → `rate_limited`.
  - Writes are never retried after an unknown outcome.
- **Also:** `api_request` (signed).

## tiktok-shop-api (TikTok Shop Partner API, 202309+ versions)
- **Env:** `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET`, `TIKTOK_SHOP_ACCESS_TOKEN`, `TIKTOK_SHOP_REFRESH_TOKEN`, `TIKTOK_SHOP_CIPHER` (shop cipher). Base `https://open-api.tiktokglobalshop.com`.
- **Signing:** HMAC-SHA256 with `app_secret`:
  1. Take the sorted query parameters, excluding `sign` and `access_token`.
  2. Build `app_secret + path + sorted key+value concatenation + body + app_secret`.
  3. Send `x-tts-access-token` as a header.
  - The signing algorithm comes from the official docs and is tested against a vector computed in the test.
- **Shop:** `get_authorized_shops`.
- **Products:** `search_products`, `get_product`, `update_inventory`, `update_price`.
- **Orders:** `search_orders`, `get_order_detail`.
- **Fulfilment:** `get_package_shipping_document` (label URL), `ship_package`.
- **Returns:** `search_returns`.
- **Customer service:** `get_conversations`, `get_conversation_messages`, `send_message`. These need the customer-service scope.
- **Token:** `refresh_access_token` (node-only, `auth.tiktok-shops.com`).
- **Errors and retries:**
  - Body `{code, message, request_id, data}`; `code != 0` means failure even with HTTP 200.
  - 36009004 / 105xxx-style auth codes → `auth_error`; 429 → `rate_limited`.
  - Writes are never retried after an unknown outcome.
- **Also:** `api_request` (signed).

## Testing
- Unit tests with fakes for every operation's request shape, signing vectors, error mapping, pagination and validation.
- `state-store` concurrency: two runners writing to the same namespace (with fake lock timing).
- `email`: injected fake transports.
- Live checks with invalid credentials only. For `email`, connect with a wrong password to a public SMTP host if possible; otherwise skip and report it. For `state-store`, run real operations in a temp dir.

## Left to the builder
Exact field lists, page sizes and file layout inside each plugin.
