# collab-webhooks operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `collab-webhooks.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `deliver` | Post one collaboration workspace event (project.changed, version.saved, member.joined) to the webhook, signed with HMAC-SHA256. Without an event it sends a test message. | event, workspace, project, details, at_ms, call, caller |
