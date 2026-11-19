# gmail-api

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Gmail API v1](https://developers.google.com/workspace/gmail/api/reference/rest):
search and read messages and threads, labels, drafts, attachments, and sending mail from the signed-in account.
For plain SMTP/IMAP with any provider see [`email`](../email/).

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). Google
credentials use the same auth files as `google-sheets` (google-auth, google-token-endpoint and service-account, copied unchanged into [`lib/`](lib/)) through
[`lib/google-rest-auth.mjs`](lib/google-rest-auth.mjs). `send_message` and `create_draft` take simple fields and
build the RFC 822 message safely in [`lib/mime-message.mjs`](lib/mime-message.mjs): plain addresses only, no line
breaks in the subject (UTF-8 subjects are RFC 2047 encoded-words folded to 75 characters), no control characters in addresses, base64 bodies, optional multipart/alternative.

## Features
- **Messages:** `get_profile`, `list_messages` (Gmail search syntax, labels), `get_message` (`full`, `metadata`,
  `minimal`, `raw`), `get_attachment` (saved to a directory), `send_message`, `modify_message` (labels: read,
  star, archive), `trash_message` (node only)
- **Threads:** `list_threads`, `get_thread`, `modify_thread`
- **Labels:** `list_labels`, `get_label`, `create_label`
- **Drafts:** `list_drafts`, `get_draft`, `create_draft`, `send_draft` (node only)
- **`api_request`:** any other endpoint under `/gmail/v1/users/me` (e.g. `/history`; GET only for agents)

Lists return `next_cursor` (Gmail's `nextPageToken`). Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the Gmail API enabled

## Installation
```bash
graphrt plugin install ./gmail-api
```

## Configuration
| Env var | Purpose |
|---|---|
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth refresh trio (recommended) |
| `GOOGLE_ACCESS_TOKEN` | A ready access token (used only when no refresh trio or key file is set; expires after an hour) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to a service account key file; Gmail mailboxes generally need domain-wide delegation, which this plugin does not do (no `sub`), so prefer OAuth |
| `GMAIL_TOOL_ALLOW_SEND` | `1` lets agent tools send mail |
| `GMAIL_TOOL_RECIPIENT_ALLOWLIST` | Comma-separated addresses or `@domain`s agent tools may send to |
| `GMAIL_ATTACHMENT_DIR` | Absolute directory where `get_attachment` saves files |

Credential order: a node's `access_token` (needs `--trust-plugin gmail-api`), then the refresh trio, then the
service account key, then `GOOGLE_ACCESS_TOKEN`. Grant tokens are cached in memory until shortly before they expire.

`GOOGLE_ACCESS_TOKEN` is ignored whenever the refresh trio or a service account key is configured (the
plugin cannot refresh after a 401, so it prefers a grant over a token of unknown age). An access token obtained
from a grant is cached in memory until a minute before it expires: after the grant is revoked or replaced in the
environment, calls keep using the cached token (failing with `auth_error` if Google rejects it) until it expires
or the plugin process restarts.

### Getting the credentials
1. Google Cloud console: enable the **Gmail API**; configure the OAuth consent screen; create an **OAuth client ID**
   (Desktop app or Web).
2. Authorize the scopes you need and exchange the code for a refresh token (e.g. with the OAuth 2.0 Playground,
   "Use your own OAuth credentials"):
   - `https://www.googleapis.com/auth/gmail.modify`: read, labels, drafts, send, trash (recommended)
   - or narrower: `gmail.readonly`, `gmail.labels`, `gmail.compose`, `gmail.send`
3. `gmail.modify`, `gmail.readonly` and `gmail.compose` are **restricted scopes**: apps used beyond your own test
   users need Google's verification and a security assessment. An app in "Testing" status issues refresh tokens
   that expire after 7 days.

**Pricing / limits:** free. Quota is 1,200,000 units a minute per project and 15,000 units a minute per user
(`messages.send` costs 100 units, `messages.get` 5). Gmail limits sending to about 500 recipients a day for
consumer accounts and 2,000 for Workspace.

## Quick Start
```bash
GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... graphrt run gmail-api/example.yaml --plugins .
```

## Usage
```yaml
- id: send
  type: gmail-api.send_message
  to: ["ops@example.com"]
  subject: "Laporan harian ✓"
  text: "All jobs passed."
  html: "<p>All jobs <b>passed</b>.</p>"
- id: reply
  type: gmail-api.send_message
  to: ["ada@example.com"]
  subject: "Re: Invoice"
  text: "Paid, thanks."
  thread_id: "{{#start.thread_id#}}"
  in_reply_to: "{{#start.message_id_header#}}"     # the original's Message-ID header, e.g. <CAB...@mail.gmail.com>
- id: archive
  type: gmail-api.modify_message
  message_id: "{{#start.message_id#}}"
  remove_label_ids: [INBOX, UNREAD]
```

## Agent policy
- Reads, `modify_message`/`modify_thread`, `create_label`, `create_draft` (not sent) and `get_attachment` are tools.
- `send_message` is a tool only with `GMAIL_TOOL_ALLOW_SEND=1`. With `GMAIL_TOOL_RECIPIENT_ALLOWLIST` set, every
  to/cc/bcc address of a tool send must match it. Nodes are not limited by the allowlist.
- `send_draft` (recipients not checked) and `trash_message` are node only.

## Errors
Google errors are `{"error": {"code", "message", "errors": [{"reason"}], "status"}}`; the plugin maps by
`reason`: `authError` → `auth_error`, `insufficientPermissions`/`forbidden` → `permission_denied`, `notFound` →
`not_found`, `invalidArgument`/`failedPrecondition` → `invalid_input`, `rateLimitExceeded`/
`userRateLimitExceeded` (also on 403) and 429 → `rate_limited`. A failed `send_message` is never retried after an
unknown outcome: look in Sent first. Bad addresses, subjects with line breaks and malformed Message-IDs are
refused before any request (`invalid_input`).

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite, byte-exact MIME tests (headers, encoding, injection attempts) and tests for the
allowlist, credential order, token redaction, attachments and the error mapping. Verified live only with an
invalid token (`auth_error`).

## License
Apache-2.0
