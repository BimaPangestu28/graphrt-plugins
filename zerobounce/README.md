# zerobounce

**Status:** beta · **ToS risk:** low. Official API; reviewed and unit-tested with fakes, but the live check never reached ZeroBounce (Cloudflare blocked the test network). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the
[ZeroBounce email validation API v2](https://www.zerobounce.net/docs/email-validation-api-quickstart/): validate
one address or a batch in real time, check credits and usage, and run bulk file validations.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs).
- [`lib/body-api-key.mjs`](lib/body-api-key.mjs) puts the key in the body for the two endpoints that read it there.
- [`lib/result-file.mjs`](lib/result-file.mjs) turns a JSON error answer from `getfile` into an error.
- [`lib/api-request-allowlist.mjs`](lib/api-request-allowlist.mjs) is copied unchanged from `brevo`.

## Features
- **`validate_email`:** status (`valid`, `invalid`, `catch-all`, `unknown`, `spamtrap`, `abuse`, `do_not_mail`),
  `sub_status`, `did_you_mean`, domain age, MX, optional activity data and Verify+
- **`validate_batch`:** up to 100 addresses per call (ZeroBounce allows 200; the plugin caps it lower). It can
  take up to 70 s.
- **`get_credits`**, **`get_api_usage`** (counts by status and sub_status between two dates)
- **Bulk files (node only):** `send_file` (CSV/TXT, column mapping, duplicate removal, Verify+ phase 2, optional
  `return_url`), `get_file_status`, `get_file` (saves the result as a `.csv` file), `delete_file`
- **`api_request`:** any other real-time endpoint (GET only for agents, and only `/getcredits` and `/getapiusage`)

Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A ZeroBounce account with credits

## Installation
```bash
graphrt plugin install ./zerobounce
```

## Configuration
| Env var | Purpose |
|---|---|
| `ZEROBOUNCE_API_KEY` | API key (`api_key` query parameter; the body for validatebatch and sendfile); redacted everywhere |
| `ZEROBOUNCE_REGION` | `default` (api.zerobounce.net), `us` (api-us, US-only processing) or `eu` (api-eu); bulk files always use bulkapi.zerobounce.net |
| `ZEROBOUNCE_TOOL_ALLOW_BATCH` | `1` lets agent tools use `validate_batch` |
| `ZEROBOUNCE_FILE_DIR` | Directory `send_file` may read local files from (realpath-checked; unset refuses local files) |
| `ZEROBOUNCE_OUTPUT_DIR` | Directory `get_file` saves result files into (required for `get_file`) |

### Getting the credentials
ZeroBounce dashboard → **API → API Keys** → create a key. Keys can be limited to IP addresses in the dashboard.

**Pricing / credits:**
- One credit per validated address. ZeroBounce never charges for an `unknown` result.
- Credits come in pay-as-you-go packs or monthly plans; the free tier includes a small monthly allowance.
  Current prices are at https://www.zerobounce.net/email-validation-pricing.
- `get_credits` and `get_api_usage` are free.
- Rate limits are on ZeroBounce's API Rate Limits page; going over them blocks the key for a while
  (`rate_limited`).

## Quick Start
```bash
ZEROBOUNCE_API_KEY=... graphrt run zerobounce/example.yaml --plugins .
```

## Usage
```yaml
- id: check
  type: zerobounce.validate_email
  email: "{{#start.email#}}"
  validation_timeout: 15
- id: upload
  type: zerobounce.send_file
  file: /data/lists/expo.csv        # inside ZEROBOUNCE_FILE_DIR
  email_address_column: 2
  has_header_row: true
- id: status
  type: zerobounce.get_file_status
  file_id: "{{#upload.data.file_id#}}"
```

`validation_timeout` is sent as ZeroBounce's `timeout` (graphrt reserves the `timeout` node key).

## Agent policy
- `validate_email` is a tool, but it spends a credit. It is `write: "unsafe"`, so a timeout or 5xx is never
  retried, and the error says to check `get_credits` / `get_api_usage` first.
- `validate_batch` is a tool only with `ZEROBOUNCE_TOOL_ALLOW_BATCH=1`, capped at 100 addresses, and also never
  retried.
- Every bulk file operation is node only:
  - `send_file` reads local files only inside `ZEROBOUNCE_FILE_DIR` (or an https URL);
  - `get_file` writes only into `ZEROBOUNCE_OUTPUT_DIR`;
  - `return_url` (ZeroBounce POSTs to it when done) exists only on this node-only operation.
- `api_request` as a tool is GET-only and limited to `/getcredits` and `/getapiusage`. `/validate` is a billed GET
  the layer would otherwise retry, so it is not reachable that way.
- The key is never a parameter. `api_key` is filled from the run's credential and hidden from every schema.

## Errors
- Real-time endpoints answer most errors with 200 `{"error": "..."}`; bulk endpoints with `{"success": false,
  "message": "..."}`. Both are detected and raised as errors.
- "Invalid API key or your account ran out of credits" becomes `auth_error`. So does `getcredits` returning `-1`,
  which is what it answers for an invalid key.
- HTTP statuses map as usual: 400 → `invalid_input`, 401 → `auth_error`, 429 → `rate_limited`.
- `get_file` deletes a saved JSON error body (unknown file id, file not finished) and raises its message.

## Testing
```bash
npm test          # from the repo root
```
The generated contract suite runs, plus tests for:
- the regional hosts and redaction;
- no retries on credit calls;
- the body `api_key` (an injected caller value is ignored);
- the batch opt-in and cap;
- invalid-key mapping;
- the api_request allowlist;
- file directories and the `getfile` error body.

Verified live only with an invalid key (`auth_error`).

## License
Apache-2.0
