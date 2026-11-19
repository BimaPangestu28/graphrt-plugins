## Summary
<!-- Which plugin or change, which API and version, and why. Link the official docs you used. -->

- Plugin / area:
- API and version:
- Type: declarative / hand-written
- Status and ToS risk proposed:

## Agent safety
<!-- Required. See CONTRIBUTING.md#agent-safety-checklist. Write "n/a" with a reason when a line does not apply. -->

- [ ] Money movement, deletes, bulk destructive and admin operations are `nodeOnly`
- [ ] Sends, posts and writes from tools need an opt-in env (`<PLUGIN>_TOOL_ALLOW_*`)
- [ ] Recipient and target allowlists where data can leave the user's control
- [ ] Paid calls are `write: "unsafe"` with a `checkHint` and are never retried; pricing is in the README
- [ ] No callback or webhook URLs on tools (only on a `nodeOnly` variant)
- [ ] `api_request` is GET-only for tools, with an allowlist of read paths where the API has secret-bearing GETs
- [ ] Secrets are stripped from results returned to tools; no credential is accepted as an argument
- [ ] Local file access only inside allowlisted directories; downloads restricted to https and allowed hosts
- [ ] Caps and timeouts are set; writes are not retried after an unknown outcome

## Plugin contents
- [ ] README with overview, env vars, credentials, scopes, pricing, agent policy and errors
- [ ] `example.yaml` using a read operation
- [ ] Row in the root README table
- [ ] Entry in `plugin-status.json` (status and `tos_risk`; `tos_notes` for medium or high)
- [ ] `docs/tos-audit.md` updated (medium or high risk only)
- [ ] Version set or bumped in `definition.mjs` (or `graphrt-plugin.json`)

## Test plan
- [ ] `npm run sync` run and the regenerated files committed (nothing under `lib/shared/`, `graphrt-plugin.json` or `OPERATIONS.md` edited by hand)
- [ ] `npm run check && npm test` passes locally
- [ ] Contract test for every operation (exact URL, query and body); custom code written test first
- [ ] No network calls in unit tests; no realistic-looking fake secrets
- [ ] `graphrt plugin info <plugin>` works
- [ ] One live `graphrt run <plugin>/example.yaml --plugins .` with an invalid credential
  - Result (exact error, e.g. `auth_error`):
- [ ] Not verified with a real account (say so here if true):

## Notes for reviewers
<!-- Judgement calls, API facts you could not verify, known gaps. -->
