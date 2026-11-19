# qontak

**Status:** experimental · **ToS risk:** low. Official WhatsApp BSP, but the HMAC request signing has not been verified against a live Mekari account. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for [Mekari Qontak](https://qontak.com), an
Indonesian CRM and omnichannel platform:
- **Qontak Chat (Omnichannel):** send approved WhatsApp templates; read templates, channel integrations, rooms
  and broadcast logs.
- **Qontak CRM:** contacts, companies, deals, tasks, notes, pipelines and stages.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
Endpoints follow Qontak's official OpenAPI spec for the Mekari gateway
([qontak-dev/docs](https://github.com/qontak-dev/docs), `Qontak-CRM-OpenAPI-MAG.json`) and Mekari's
[qontak-api-js](https://github.com/mekari-engineering/qontak-api-js) SDK.

| File | What it does |
|---|---|
| [`lib/qontak-auth.mjs`](lib/qontak-auth.mjs) | Picks the auth scheme and hosts |
| [`lib/mekari-hmac.mjs`](lib/mekari-hmac.mjs) | Signs Mekari HMAC requests |
| [`lib/crm-operations.mjs`](lib/crm-operations.mjs) | Builds the CRM operations |
| [`lib/secret-fields.mjs`](lib/secret-fields.mjs) | Strips secrets from integration records for agent tools |
| [`lib/recipient-policy.mjs`](lib/recipient-policy.mjs) | Recipient allowlist, copied unchanged from `twilio` |
| [`lib/api-request-allowlist.mjs`](lib/api-request-allowlist.mjs) | api_request read-path allowlist, copied unchanged from `brevo` |

## Features
- **WhatsApp:**
  - `send_whatsapp_template` (a direct broadcast to one number with template variables);
  - templates: `list_whatsapp_templates`, `get_whatsapp_template`;
  - channels: `list_integrations` (`channel_integration_id`);
  - broadcasts: `list_whatsapp_broadcasts`, `get_whatsapp_broadcast`, `get_whatsapp_broadcast_log` (per-recipient
    sent/delivered/read/failed).
- **Rooms:** `list_rooms`, `get_room`, `list_room_histories`.
- **CRM** (contacts, companies, deals, tasks, notes):
  - `list_*` (page/per_page via `limit`/`cursor`, filters), `get_*`, `create_*`, `update_*`;
  - `delete_*` (node only);
  - custom fields via `additional_fields`.
- **Pipelines:** `list_pipelines`, `get_pipeline`, `list_pipeline_stages`.
- **`api_request`:** any other Chat endpoint (GET only for agents, and only `/templates`, `/rooms`, `/broadcasts`).

Chat results are the `data` of Qontak's `{status, data, meta}` envelope, CRM results the `response` of
`{meta, response}`. Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Qontak account. Template sends need a connected WhatsApp Business channel and approved templates.

## Installation
```bash
graphrt plugin install ./qontak
```

## Configuration
| Env var | Purpose |
|---|---|
| `QONTAK_CLIENT_ID`, `QONTAK_CLIENT_SECRET` | Mekari Developer application credentials, for HMAC auth on `api.mekari.com` (recommended) |
| `QONTAK_CRM_USER_SSO_ID` | Optional: the CRM user (SSO id) actions are done as, sent as `X-Crm-User-Sso-Id` on CRM requests |
| `QONTAK_CHAT_TOKEN` | Omnichannel API token (bearer, older host `service-chat.qontak.com`) |
| `QONTAK_CRM_TOKEN` | CRM API token (bearer, older host `app.qontak.com/api/v3.1`) |
| `QONTAK_AUTH_MODE` | Force `hmac` or `bearer` (default: `hmac` when the client id and secret are set) |
| `QONTAK_TOOL_ALLOW_SEND` | `1` lets agent tools use `send_whatsapp_template` |
| `QONTAK_TOOL_RECIPIENT_ALLOWLIST` | Comma-separated E.164 numbers agent tools may send to (required for tool sends) |
| `QONTAK_TOOL_ALLOW_CRM_WRITES` | `1` lets agent tools create and update CRM records |

### Getting the credentials
- **Mekari API (HMAC, recommended):**
  1. As the company owner, go to https://developers.mekari.com and create an application.
  2. Tick the Qontak scopes, e.g. `qontak-chat:all` and `qontak-crm:all`, or per-endpoint scopes.
  3. Copy the Client ID and Client Secret.

  Each request is signed: `Authorization: hmac username="<client id>", algorithm="hmac-sha256",
  headers="date request-line", signature="<base64 HMAC-SHA256 of 'date: <Date>\n<METHOD> <path?query>
  HTTP/1.1'>"`, plus a `Date` header (the gateway allows 300 s of clock skew). Requests with a body (POST, PUT,
  PATCH, DELETE) also send `Digest: SHA-256=<base64 SHA-256 of the exact body>`, as Mekari's HMAC page requires.
  Qontak asked customers to move to `api.mekari.com` by April 2025.

  > **Signing has not been verified live.** No real Mekari credentials were available. The tests check the
  > signature and Digest against vectors computed independently with `openssl dgst -sha256 -hmac`, and an invalid
  > client id/secret gets a clean 401 from the gateway. A valid signature has never been accepted in testing.
  >
  > **Query encoding:** the query is signed exactly as sent (percent-encoded), the way Kong's hmac-auth plugin
  > rebuilds the request line. Mekari's qontak-api-js SDK signs the URL-decoded query instead. The two agree
  > unless a query value contains percent-encoded characters (spaces, `@`, non-ASCII in a `query` search, ...).
  > If the gateway rejects such requests, that difference is the first thing to check.

  A node's `access_token` is a bearer token. It is refused in HMAC mode (`invalid_input`), because the gateway
  only accepts signed requests. Set `QONTAK_AUTH_MODE=bearer` to use it on the older hosts, where it replaces
  `QONTAK_CHAT_TOKEN` / `QONTAK_CRM_TOKEN`.
- **Bearer tokens (older hosts):**
  - Omnichannel: Qontak Chat → Settings → API token → Omnichannel tab (valid one year).
  - CRM: Qontak CRM → API token (short-lived).

**Pricing:** WhatsApp template messages are billed by Meta per conversation or message category (marketing,
utility, authentication), through your Qontak plan or balance. Every `send_whatsapp_template` can cost money.
Direct broadcasts are limited to 60 requests a minute.

## Quick Start
```bash
QONTAK_CLIENT_ID=... QONTAK_CLIENT_SECRET=... graphrt run qontak/example.yaml --plugins .
```

## Usage
```yaml
- id: otp
  type: qontak.send_whatsapp_template
  to_number: "+6281234567890"
  to_name: "{{#start.name#}}"
  message_template_id: "{{#start.template_id#}}"
  channel_integration_id: "{{#start.channel_id#}}"
  language_code: id
  parameters: { body: [{ key: "1", value_text: "{{#start.code#}}", value: "otp" }] }
- id: deal
  type: qontak.create_deal
  name: "Paket A - {{#start.name#}}"
  crm_pipeline_id: 2
  crm_stage_id: 1
  currency: IDR
  size: 1500000
```

- `to_number` must be E.164 with `+`. A national number like `0812...` is refused, so it can never be read with
  the wrong country code. It is sent as digits (`6281234567890`), which is the form Qontak takes.
- `note_type` is sent as `type` (graphrt reserves that node key), e.g. `Crm::PersonNote`.

## Agent policy
- **Template sends:** `send_whatsapp_template` is unsafe, never retried after an unknown outcome; check
  `get_whatsapp_broadcast_log` first. A tool send needs both gates (nodes are not limited):
  - `QONTAK_TOOL_ALLOW_SEND=1`;
  - the recipient in `QONTAK_TOOL_RECIPIENT_ALLOWLIST`.

  The allowlist file is the `twilio` one. Entries are exact E.164 numbers (or explicit `+digits*` prefixes with
  at least 4 digits). An unset or empty allowlist refuses every tool send.
- **Bulk broadcasts:** not implemented (see Known gaps). They would be node only.
- **CRM:** create and update need `QONTAK_TOOL_ALLOW_CRM_WRITES=1` as tools. Every CRM delete is node only.
- **Integrations:** in tool results, `list_integrations` replaces with `[removed]`:
  - fields whose name looks secret (token, secret, password, api key, bearer, auth/authorization, credential,
    signature, cookie, session, webhook);
  - the `value` of `{key|name, value}` pairs whose name looks secret, such as header lists;
  - anything nested more than 20 levels deep (dropped, not returned unchecked).

  Nodes get the full records.
- **`api_request`:** as a tool it is GET-only and limited to `/templates`, `/rooms` and `/broadcasts`. Paths are
  compared after repeated percent-decoding; dot segments are refused. `/integrations` is excluded, since channel
  configs can hold credentials.
- **Personal data:** rooms, contacts and broadcast logs hold customer names and phone numbers. Treat them as
  personal data under UU PDP.

## Errors
- 401 (`{"message": "Unauthorized"}` from the gateway, `Invalid token` on the older hosts) → `auth_error`
- 403 → `permission_denied`, 404 → `not_found`, 422 → `invalid_input`, 429 → `rate_limited`
- The message comes from `error.messages[0]` (Chat), `meta.developer_message` (CRM) or `message`.
- Missing credentials and an unknown `QONTAK_AUTH_MODE` are refused before any request.

## Known gaps (not verifiable in Qontak's public docs)
- **Bulk WhatsApp broadcast** (`POST /broadcasts/whatsapp` to a contact list): the endpoint is named, but its
  request body is not documented. Creating contact lists (CSV upload) is not documented either.
- **Listing the messages of a room and agent replies in a room:** no documented gateway endpoint.
  `list_room_histories` returns room history entries, not messages.
- **HMAC not verified live:** see "Getting the credentials". This includes the query-encoding choice (signed as
  sent, like Kong hmac-auth, unlike the SDK) and the Digest header.
- **CRM create:** which fields are mandatory is not fully documented. The plugin requires `first_name` (contacts),
  `name` (companies, tasks), `name` + `crm_pipeline_id` + `crm_stage_id` (deals) and `note` (notes).

## Testing
```bash
npm test          # from the repo root
```
The generated contract suite (with HMAC signature checks on every request) runs, plus tests for:
- openssl-computed HMAC and Digest vectors (fixed date, method, path and query), both auth modes and hosts, the SSO header, node tokens;
- the send opt-in, the E.164 allowlist and no retries;
- CRM opt-ins;
- integration secret stripping and the api_request allowlist.

Verified live only with invalid credentials. HMAC on `api.mekari.com` and bearer tokens on the older hosts both
returned `auth_error`.

## License
Apache-2.0
