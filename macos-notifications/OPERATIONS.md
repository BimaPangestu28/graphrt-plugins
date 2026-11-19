# macos-notifications operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `macos-notifications.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `notify` | Shows a local macOS notification (title, optional subtitle, message, optional system sound) on this Mac; agent calls are rate limited | **message**, notification_title, subtitle, sound |
