# collab-webhooks

**Status:** beta · **ToS risk:** none. No third party API: posts to the address a workspace owner grants. Unit-tested with fakes; the service path checked end to end on a real graphrt collab server (granted secrets arrive, a loopback address is refused). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin service for the collaboration server (`graphrt collab`,
see [docs/collab.md](https://github.com/Graphrt/graphrt/blob/main/docs/collab.md)). When a workspace owner turns
it on, the server posts the workspace's events to the team's webhook: a project changed (a few seconds after
people stop editing), a version was saved, someone joined. Slack and Microsoft Teams incoming webhooks show the
`text` line, any other HTTPS endpoint gets the whole event and can check its signature.

It is also a plain workflow node and agent tool (`collab-webhooks.deliver`) that posts to `COLLAB_WEBHOOK_URL`.

## Features
- **`webhook` service** (manifest `services`): events `project.changed`, `version.saved`, `member.joined`,
  owners only, secrets `WEBHOOK_URL` and `WEBHOOK_SECRET` granted per workspace. Project content is never sent
  (`reads_projects: false`): only names, ids, who and when.
- **`deliver`**: posts one event, or a test message when called without an event.
- **Signed**: with a secret, `X-Graphrt-Signature: sha256=<hex HMAC-SHA256 of the body>`.
- **Safe**: public `https://` addresses only (no loopback, private or link local hosts), no redirects, a 15 s
  time limit, nothing of the secrets in errors.

## Prerequisites
- Node.js >= 20
- A graphrt collaboration server with plugin services (`plugins:` in its config), or graphrt for the node

## Installation
On the collaboration server:

```bash
graphrt plugin install collab-webhooks --dir /plugins
```

```yaml
# collab.yaml
plugins:
  dirs: [/plugins]
  trusted: [collab-webhooks]   # so it may receive the workspace secrets an owner grants
```

No `npm install` needed: the plugin has no dependencies.

## Configuration
A workspace owner sets the secrets and enables the service (Graphrt Desktop, or the API):

```bash
curl -X PUT "$SERVER/v1/workspaces/$WS/secrets/WEBHOOK_URL" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"value": "https://hooks.slack.com/services/..."}'
curl -X PUT "$SERVER/v1/workspaces/$WS/secrets/WEBHOOK_SECRET" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"value": "a long random string"}'
curl -X PUT "$SERVER/v1/workspaces/$WS/services/collab-webhooks/webhook" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"enabled": true, "secrets": ["WEBHOOK_URL", "WEBHOOK_SECRET"]}'
# A test message:
curl -X POST "$SERVER/v1/workspaces/$WS/services/collab-webhooks/webhook/call" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}'
```

As a node, the plugin reads:

| Variable | What |
| --- | --- |
| `COLLAB_WEBHOOK_URL` | The webhook address (`https://` only) |
| `COLLAB_WEBHOOK_SECRET` | Optional: signs the body |

## What is posted

```json
{
  "text": "Ana changed “Support bot” in “Acme team”",
  "graphrt": {
    "type": "project.changed",
    "event": "project.changed",
    "workspace": { "id": "ws_…", "name": "Acme team" },
    "project": { "id": "pr_…", "name": "Support bot" },
    "details": { "by": "acct_…" },
    "at_ms": 1795000000000
  }
}
```

Check the signature on the receiving side with the raw body:
`hmac_sha256_hex(WEBHOOK_SECRET, body) == header.removeprefix("sha256=")`, compared in constant time.

## Usage
See [example.yaml](example.yaml) for the node. The full operation reference is in [OPERATIONS.md](OPERATIONS.md).

## License
Apache-2.0
