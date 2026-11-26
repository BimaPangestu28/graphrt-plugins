# typeform

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for the [Typeform APIs](https://www.typeform.com/developers/):
list and read forms, read responses with filters and paging, form insights and workspaces, create forms, and delete
forms or responses from workflows. Works with US and EU data centers.

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs), plus
[`lib/typeform-region.mjs`](lib/typeform-region.mjs) (API host) and
[`lib/api-request-policy.mjs`](lib/api-request-policy.mjs) (read-path allowlist for agent `api_request`).

## Features
- **`get_me`:** the token's account
- **`list_forms`:** search by title, filter by workspace, sort by `created_at`/`last_updated_at`; `limit` (up to
  200) and page `cursor`
- **`get_form`:** the full definition (fields with `id` and `ref`, logic, settings) and `_links.responses`
- **`create_form`:** from a [Create API form definition](https://www.typeform.com/developers/create/reference/create-form/)
- **`delete_form`:** deletes a form and all its responses
- **`list_responses`:** newest first; filter by `since`/`until`, `after` a response token, response ids,
  `response_type` (started, partial, completed), an exact-phrase `search`, `fields` and `answered_fields`.
  `limit` up to 1000; `next_cursor` is the last response's token and fetches the older ones (`before`). The last
  page is detected by an empty page, so a full final page costs one extra call. Typeform may hold back responses of
  the last ~30 minutes (use webhooks for real time).
- **`delete_responses`:** up to 1000 response ids (queued deletion; unknown ids are ignored)
- **`get_insights_summary`:** visits, responses, completion rate and average time, per form and question (depends on
  the plan)
- **`list_workspaces`**, **`get_workspace`**
- **`api_request`:** any other endpoint, e.g. `/forms/<id>/messages` or `/themes` (agents: GET on allowed read
  paths only)

Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Typeform account

## Installation
```bash
graphrt plugin install ./typeform
```

## Configuration
| Env var | Purpose |
|---|---|
| `TYPEFORM_TOKEN` | Personal access token (or an OAuth access token), sent as `Authorization: Bearer` |
| `TYPEFORM_BASE_URL` | API host: `https://api.typeform.com` (default, US), `https://api.eu.typeform.com` (EU accounts) or `https://api.typeform.eu` (new EU data center); anything else is refused |
| `TYPEFORM_TOOL_ALLOW_CREATE` | `1` lets agent tools call `create_form` |

**Data centers:** responses of an EU account are only returned by the EU host; the US host answers with an empty
list, not an error. If responses look empty, call `get_form` and check the host in `_links.responses`.

### Getting the credentials
Typeform → Account → **Personal tokens** → Generate a new token. Grant only what you use: `accounts:read`,
`forms:read`, `responses:read`, `workspaces:read` for reads, `forms:write` for `create_form`/`delete_form`,
`responses:write` for `delete_responses`. Do not grant `webhooks:read`/`webhooks:write` unless a workflow needs
them (webhook reads return signing secrets).

**Pricing / limits:** API calls are not billed per request (they use your plan); insights and some form features need a paid plan
(`PAYMENT_REQUIRED` → `permission_denied`). The Create and Responses APIs allow 2 requests per second per account
(429 → `rate_limited`).

## Quick Start
```bash
TYPEFORM_TOKEN=tfp_... graphrt run typeform/example.yaml --plugins .
```

## Usage
```yaml
- id: fresh
  type: typeform.list_responses
  form_id: "{{#start.form_id#}}"
  since: "{{#start.since#}}"
  response_type: [completed]
  limit: 200
- id: cleanup
  type: typeform.delete_responses      # node only
  form_id: "{{#start.form_id#}}"
  included_response_ids: ["{{#fresh.data.0.response_id#}}"]
```

## Agent policy
- Reads (`get_me`, `list_forms`, `get_form`, `list_responses`, `get_insights_summary`, `list_workspaces`,
  `get_workspace`) are tools.
- `create_form` is a tool only with `TYPEFORM_TOOL_ALLOW_CREATE=1`: forms are public by default, so an agent could
  otherwise publish content anyone with the link can see.
- `delete_form` and `delete_responses` are node only.
- `api_request` as a tool is GET-only and limited to an allowlist of read paths (`/me`, `/forms`, `/forms/{id}`,
  `/forms/{id}/responses`, `/forms/{id}/messages`, `/workspaces[/{id}]`, `/themes[/{id}]`, `/images`,
  `/insights/{id}/summary`); webhook endpoints, which return signing secrets, are refused.

## Per-user tokens (multi-user agents)

Set `TYPEFORM_TOOL_TOKEN_SOURCE=context` when one agent serves many end users: every tool call then uses the end user's own
token, sent by graphrt per call from the `agent` node's `tool_context` (needs a graphrt host with tool call context
and `--trust-plugin typeform`):

```yaml
tools: [typeform/get_me]
tool_context:
  typeform:
    access_token: "{{#start.typeform_token#}}"   # the end user's token, e.g. from your app's login
```

- `access_token` is an OAuth access token (or personal API token) of that user.
- A tool call without it (missing, empty or masked) is refused with `auth_error` before any request. Tools never fall
  back to `TYPEFORM_TOKEN` in this mode; workflow nodes still use them.
- The token is redacted from tool results and errors and never logged. The other tool limits above still apply.
- Unset (or `env`) keeps the default: tools use the env credential. Any other value refuses every tool call.

## Errors
Errors are `{"code", "description", "details"}`: `UNAUTHORIZED` (401) and `AUTHENTICATION_FAILED` (what an invalid token gets live) / `AUTHENTICATION_ERROR` /
`INVALID_AUTHORIZATION` (403) → `auth_error`, `NOT_EXISTING_ID` → `not_found`, `VALIDATION_ERROR` → `invalid_input`
(details name the field), `PAYMENT_REQUIRED` → `permission_denied`, 429 → `rate_limited`. `create_form` is never
retried after an unknown outcome: check `list_forms` first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for paging, the data center host, the opt-in, the api_request allowlist and the
error mapping. Verified live only with an invalid token (`auth_error`).

## License
Apache-2.0
