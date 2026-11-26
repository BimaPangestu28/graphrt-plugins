# email

**Status:** beta · **ToS risk:** low. Live verify_connection against smtp.gmail.com with a wrong password gave auth_error (PR #18); no mail sent, IMAP tested with fakes only. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin that sends email over **SMTP** (nodemailer) and reads,
flags and moves messages over **IMAP** (imapflow). It works with any provider that offers SMTP/IMAP login with a
password, typically an *app password*.

## Features
- **Connection check:** `verify_connection` logs in to SMTP and/or IMAP and logs out. It sends and changes nothing.
- **Sending:** `send_email` takes to/cc/bcc, subject, text and/or html, and reply_to. Use `in_reply_to` and
  `references` for threading. Attachments (workflow nodes only) can come from https URLs or from local files in
  allowed directories. As an agent tool it only emails recipients in `EMAIL_TOOL_ALLOWED_RECIPIENTS`.
- **Reading:**
  - `list_messages`: newest first. Filters: `unseen_only`, `since`, `from`, `subject`. Each message comes with
    uid, from/to/cc, subject, date, flags and a 200-character snippet.
  - `read_message`: headers, `message_id` / `in_reply_to` / `references` for replies, the body as plain text, and
    attachment metadata.
  - `list_mailboxes`: folders with their special use, and counts when `include_counts` is set.
- **Organising:** `mark_seen`, `mark_unseen` and `move_message` work by UID, at most 100 per call.
- Every operation is a node `email.<operation>` and an agent tool. The full reference is in
  [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20
- graphrt with plugin support
- An account with SMTP/IMAP access and an app password (see the presets below)

## Installation
```bash
cd email
npm install          # nodemailer and imapflow (pinned versions)
graphrt plugin install .
```
The plugin runs `node plugin.mjs` from its own directory, so `node_modules/` must sit next to it. Without it,
every operation fails with `setup_required`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `EMAIL_PASSWORD` | (required) | App password, used for SMTP and IMAP. A node's `access_token` (from a secret, with `--trust-plugin email`) overrides it. |
| `EMAIL_SMTP_HOST` | (none) | SMTP server, needed for sending |
| `EMAIL_SMTP_PORT` | `465` | SMTP port |
| `EMAIL_SMTP_SECURE` | `true` | `true` = implicit TLS (465). `false` = STARTTLS (587), which is then **required**, so the password never travels in clear text. |
| `EMAIL_SMTP_USER` | (none) | SMTP login |
| `EMAIL_IMAP_HOST` | (none) | IMAP server, needed for reading |
| `EMAIL_IMAP_PORT` | `993` | IMAP port |
| `EMAIL_IMAP_SECURE` | `true` | `false` = STARTTLS, which is then required |
| `EMAIL_IMAP_USER` | `EMAIL_SMTP_USER` | IMAP login |
| `EMAIL_FROM` | `EMAIL_SMTP_USER` | Sender, e.g. `"Toko Budi" <budi@example.com>`. Tools cannot change it. |
| `EMAIL_DAILY_SEND_LIMIT` | `200` | Recipients per local day (to + cc + bcc of every attempted message). `0` disables sending. |
| `EMAIL_ALLOWED_FILE_DIRS` | (none) | Comma-separated directories that local attachments may come from. Leave it unset to allow https URLs only. |
| `EMAIL_TOOL_ALLOWED_RECIPIENTS` | (none) | Who **agents** may email with the `send_email` tool: comma-separated exact addresses and/or `@domain` entries, case-insensitive, e.g. `budi@example.com, @toko.co.id` (a domain entry does not cover subdomains). Unset, agent tool calls to `send_email` are refused. Workflow nodes are not limited by it. |
| `EMAIL_STATE_DIR` | `~/.graphrt/email` | Where the daily send counter is stored (one file per SMTP account) |

### Presets
**Gmail** (verified against Google's IMAP/SMTP developer page):
```bash
EMAIL_SMTP_HOST=smtp.gmail.com  EMAIL_SMTP_PORT=465  EMAIL_SMTP_SECURE=true
EMAIL_IMAP_HOST=imap.gmail.com  EMAIL_IMAP_PORT=993
EMAIL_SMTP_USER=you@gmail.com   EMAIL_PASSWORD=<16-character app password>
```
Gmail no longer accepts your normal password from third-party apps. Turn on 2-Step Verification, then create an
app password at <https://myaccount.google.com/apppasswords>. Port 587 works too, with
`EMAIL_SMTP_SECURE=false` (STARTTLS).

**Outlook.com / Microsoft 365:**
```bash
EMAIL_SMTP_HOST=smtp-mail.outlook.com  EMAIL_SMTP_PORT=587  EMAIL_SMTP_SECURE=false
EMAIL_IMAP_HOST=outlook.office365.com  EMAIL_IMAP_PORT=993
```
Microsoft's page says Outlook.com requires Modern Auth (OAuth2), and this plugin only does password login.
Password and app-password login therefore works only where Microsoft (or your tenant admin) still allows basic
authentication for SMTP/IMAP. For Outlook.com, IMAP must also be enabled under Settings > Mail > Forwarding and
IMAP. Run `verify_connection` first.

## Quick Start
```bash
export EMAIL_SMTP_HOST=smtp.gmail.com EMAIL_SMTP_USER=you@gmail.com EMAIL_PASSWORD=...
graphrt run email/example.yaml --plugins .
```

## Usage
```yaml
- id: unread
  type: email.list_messages
  unseen_only: true
  limit: 10
- id: reply
  type: email.send_email
  to: "{{#unread.data.messages.0.from.0.address#}}"
  subject: "Re: {{#unread.data.messages.0.subject#}}"
  text: "Terima kasih, pesanan Anda kami proses."
  in_reply_to: "{{#unread.data.messages.0.message_id#}}"
```
Attachments are a JSON array:
`[{"source": "https://files.example.com/invoice-12.pdf"}, {"source": "/srv/invoices/12.pdf", "filename": "Invoice 12.pdf"}]`.
For pagination, pass `next_cursor` from `list_messages` back as `cursor`. A cursor is tied to the mailbox's
UIDVALIDITY.

## Safety
- **Agents (tool calls) vs workflows (nodes):** an agent can be steered by the mail it reads, so the
  `send_email` tool is limited:
  - Every to, cc and bcc recipient must match `EMAIL_TOOL_ALLOWED_RECIPIENTS`. When it is unset, agents cannot
    send at all (`permission_denied`).
  - Agents cannot attach anything (local files or URLs), so they cannot mail out files or fetch URLs through
    the plugin (`permission_denied`).
  - Workflow nodes (`email.send_email` in a YAML file you wrote) are not affected.
- **Header injection:** CR, LF, NUL or Unicode line separators in the subject, any address, the reply-to,
  Message-IDs or attachment names are refused. Addresses are parsed by the plugin, and only `addr@domain` and
  `Name <addr@domain>` are accepted (no groups, and no `@` in display names, which could pass for another
  address). Message-IDs may not contain control characters. A message may have at most 50 recipients.
- **Daily cap:**
  - Recipients are counted before the message is handed to SMTP, so failed attempts count too.
  - If the counter file is unreadable or corrupt, sending is blocked (`rate_limited`) until you fix or delete it.
  - Several graphrt processes can share one counter: each update holds a lock file (`<counter>.lock`). A lock
    whose process has died, or that is older than the last boot, is taken over. If a live process holds it for
    more than 10 s, the send fails with a retryable `rate_limited` and nothing is sent.
- **No retries for writes:**
  - Sends are never retried. A send error says either "Nothing was sent" (login, refused recipients, refused
    content) or that the outcome is unknown. If the outcome is unknown, check your Sent mailbox before sending
    again.
  - Flag changes and moves are not retried after a network failure either. When the server does not confirm
    a flag change or move, the result is an `api_error` saying it may or may not have been applied.
  - UIDs that do not exist are skipped and listed in `missing_uids`. If none exist, nothing is sent to the
    server and the call fails with `not_found`.
  - `move_message` needs the MOVE or UIDPLUS extension (Gmail, Outlook and most servers have both). Without
    either, a move ends with a plain EXPUNGE that would also delete other messages marked `\Deleted`, so it is
    refused.
- **Password redaction:** server responses and library messages pass through a redactor before they leave the
  plugin. It removes the password, its space-less form, its IMAP-quoted form and the base64 AUTH PLAIN/LOGIN
  forms.
- **HTML is never rendered:** HTML bodies are converted to text by a linear string scanner. Script, style and
  head content is dropped, and links keep only http(s)/mailto targets. Bodies are read up to 1 MB per part, and
  `max_text_chars` caps the returned text.
- **Read-only by default:**
  - Reads open the mailbox with EXAMINE, so `read_message` changes nothing unless you set `mark_seen: true`.
  - Attachment content is never downloaded or returned, only described.
- **Attachments you send:**
  - Workflow nodes only (see above).
  - https only, on public hosts: redirects are followed one hop at a time (at most 5), and every hop must be
    https. Host names are resolved and refused when they point to loopback, private, link-local or other
    internal addresses (`localhost`, 10.x, 192.168.x, 169.254.x, `::1`, `fe80::`, ...). fetch resolves the
    name again, so a DNS server that changes its answer in between is not caught. No credentials are sent to
    the file host.
  - Local files must be regular files inside `EMAIL_ALLOWED_FILE_DIRS`, checked on the path as given and again
    with realpath, so symlinks cannot escape. A missing file and a file outside those directories get the same
    error. FIFOs and devices are refused before they are opened.
  - At most 10 attachments and 18 MB in total. Downloads are streamed with the cap enforced and share a 45 s
    budget.
  - nodemailer's own file and URL access is disabled.
- **Connections:**
  - One connection per operation. IMAP always logs out in `finally`.
  - Timeouts: SMTP connect 20 s, greeting 15 s, 45 s idle. IMAP connect 20 s, greeting 15 s, 60 s idle.
  - Cancelling closes the socket, for sends too (the plugin hands nodemailer the socket and destroys it on
    cancel). A send cancelled after the message was handed over may still have been delivered: the error then
    says the outcome is unknown.
  - Library logging is off, because stdout carries the plugin protocol. IMAP connection errors that arrive
    after an operation ended are logged (redacted) to stderr.

## Errors
| Kind | When |
|------|------|
| `auth_error` | Wrong user or password, or no `EMAIL_PASSWORD` |
| `network_error` | Cannot connect, timeout, TLS failure. Retryable for reads and checks, never for sends, flag changes or moves. |
| `rate_limited` | Daily cap reached or counter file unusable, counter locked by another process (retryable), a 4xx SMTP reply, or IMAP throttling |
| `invalid_input` | Bad arguments, an attachment that is missing or not allowed, an internal attachment host, a server without MOVE/UIDPLUS for `move_message`, or recipients/message refused by the server ("Nothing was sent") |
| `permission_denied` | Agent tool call to `send_email` with `EMAIL_TOOL_ALLOWED_RECIPIENTS` unset, a recipient outside it, or attachments |
| `not_found` | Unknown mailbox, message UID (none of the given UIDs exist), or attachment URL (HTTP 404) |
| `setup_required` | Missing host/user settings, or `npm install` not run |
| `cancelled` | The run was cancelled or the tool deadline passed |
| `api_error` | Any other server refusal, or a flag change or move the server did not confirm (not retryable; it may or may not have been applied) |

## License
Apache-2.0
