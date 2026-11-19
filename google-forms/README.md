# google-forms

**Status:** beta · **ToS risk:** none. Official API; reviewed and unit-tested with fakes, checked live only with an invalid credential (auth_error). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for the [Google Forms API v1](https://developers.google.com/workspace/forms/api/reference/rest):
read forms and their responses, create forms, edit questions with batch updates, publish or close forms, and manage
Pub/Sub watches for new responses. To find forms by name use [`google-drive`](../google-drive/) (mimeType
`application/vnd.google-apps.form`); to copy responses into a sheet use [`google-sheets`](../google-sheets/).

Built with the [declarative REST layer](../docs/declarative-plugins.md): [`definition.mjs`](definition.mjs). Google
credentials use the same auth files as `google-sheets` (google-auth, google-token-endpoint and service-account,
copied unchanged into [`lib/`](lib/)) through [`lib/google-rest-auth.mjs`](lib/google-rest-auth.mjs), copied
unchanged from `google-docs`.

## Features
- **`get_form`:** title, description, settings, questions (`items[]` with `questionId`), `publishSettings` and the
  respondent link `responderUri`
- **`list_responses`:** submitted responses (answers keyed by `questionId`), up to 5,000 per page with `limit` and
  `cursor`; `filter` takes only `timestamp > T` or `timestamp >= T` (RFC 3339 UTC)
- **`get_response`:** one response by `responseId`
- **`create_form`:** a new empty form with a title (`form_title`; optionally `unpublished`, closed to responses)
- **`batch_update`:** raw [batchUpdate requests](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/batchUpdate)
  (`createItem`, `updateItem`, `moveItem`, `deleteItem`, `updateFormInfo`, `updateSettings`), with
  `required_revision_id` to fail when the form changed meanwhile
- **`set_publish_settings`:** `is_published` and `is_accepting_responses` (accepting needs published)
- **`list_watches`**, **`create_watch`**, **`renew_watch`**, **`delete_watch`:** Pub/Sub notifications for new
  responses (`RESPONSES`) or edits (`SCHEMA`); a watch lasts 7 days and each Cloud project may have one per event
  type per form
- **`api_request`:** any other endpoint (GET only for agents)

Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- A Google Cloud project with the Google Forms API enabled (and Cloud Pub/Sub for watches)

## Installation
```bash
graphrt plugin install ./google-forms
```

## Configuration
| Env var | Purpose |
|---|---|
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth refresh trio |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to a service account key file (scopes `forms.body` and `forms.responses.readonly`); share each form with the service account's email |
| `GOOGLE_ACCESS_TOKEN` | A ready access token (used only when neither of the above is set) |
| `GOOGLE_FORMS_TOOL_ALLOW_EDIT` | `1` lets agent tools call `batch_update` |
| `GOOGLE_FORMS_TOOL_ALLOW_PUBLISH` | `1` lets agent tools call `set_publish_settings` |

Credential order: a node's `access_token` (needs `--trust-plugin google-forms`), then the refresh trio, then the
service account, then `GOOGLE_ACCESS_TOKEN`. `GOOGLE_ACCESS_TOKEN` is ignored whenever a grant is configured (the
plugin cannot refresh after a 401). Grant tokens are cached in memory until a minute before they expire.

### Getting the credentials
1. Google Cloud console: enable the **Google Forms API**.
2. Create an OAuth client and get a refresh token with the scopes you need:
   - `https://www.googleapis.com/auth/forms.body.readonly` to read forms (or `forms.body` to also create, edit,
     publish and watch them),
   - `https://www.googleapis.com/auth/forms.responses.readonly` to read responses.

   Or create a service account, download a JSON key and share the forms with its `client_email`.
3. For watches: create a Pub/Sub topic in the same project and grant `forms-notifications@system.gserviceaccount.com`
   the Pub/Sub Publisher role on it.

**Pricing / limits:** standard use is free. Quotas per minute: 975 reads per project (390 per user), 450
`list_responses` calls per project (180 per user) and 375 writes per project (150 per user); a 429 is
`rate_limited`. Google has announced that usage above the quotas will be billed to the Cloud project later in 2026.

## Quick Start
```bash
GOOGLE_REFRESH_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... graphrt run google-forms/example.yaml --plugins .
```
Replace `form_id` in [`example.yaml`](example.yaml) with one of your forms.

## Usage
```yaml
# New responses since a time, e.g. in a scheduled workflow
- id: fresh
  type: google-forms.list_responses
  form_id: "{{#start.form_id#}}"
  filter: "timestamp > {{#start.since#}}"
# Add a question to a form
- id: add_question
  type: google-forms.batch_update
  form_id: "{{#start.form_id#}}"
  requests:
    - createItem:
        item: { title: "Your email", questionItem: { question: { required: true, textQuestion: {} } } }
        location: { index: 0 }
```

## Agent policy
- `get_form`, `list_responses`, `get_response`, `list_watches` and `create_form` are tools. Google publishes new
  forms by default, so **`create_form` as a tool always sends `unpublished=true`**: the form is closed to
  respondents until `set_publish_settings` (behind its opt-in) or a node publishes it. Nodes choose freely.
- `batch_update` is a tool only with `GOOGLE_FORMS_TOOL_ALLOW_EDIT=1` (raw requests can delete questions).
- `set_publish_settings` is a tool only with `GOOGLE_FORMS_TOOL_ALLOW_PUBLISH=1` (it opens a form to respondents or
  stops it collecting responses).
- `create_watch`, `renew_watch` and `delete_watch` are node only: watches push form events to a Pub/Sub topic.
- `api_request` is GET-only for agents.

## Errors
Forms errors are `{"error": {"code", "message", "status"}}`, mapped by `status`: `UNAUTHENTICATED` → `auth_error`,
`PERMISSION_DENIED` → `permission_denied` (also when the API is disabled in the project), `NOT_FOUND` →
`not_found`, `INVALID_ARGUMENT`/`FAILED_PRECONDITION` (e.g. a changed revision) → `invalid_input`,
`RESOURCE_EXHAUSTED`/429 → `rate_limited`. `create_form`, `batch_update` and `create_watch` are never retried after
an unknown outcome: check with `get_form`/`list_watches` (or Drive) first.

## Testing
```bash
npm test          # from the repo root
```
Generated contract suite plus tests for the opt-ins, credentials and error mapping. Verified live only with an
invalid token (`auth_error`).

## License
Apache-2.0
