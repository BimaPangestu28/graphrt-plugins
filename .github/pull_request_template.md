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

## Community plugin (only for a `community-plugins.json` entry)
<!-- See docs/community-plugins.md. Delete this section otherwise; for a community entry, delete "Plugin contents"
     and "Test plan" above (keep "Agent safety": it applies to your plugin's code). -->

- Repository and tag:
- Plugin version / previous reviewed tag (new versions):
- [ ] The PR changes only `community-plugins.json` (one entry, sorted by name)
- [ ] The tag names the manifest version; the release asset is `<name>-<version>.tar.gz` and will not be replaced
- [ ] `tarball_sha256` is the sha256 printed by `scripts/pack-plugins.mjs --plugin-dir` (or `shasum -a 256`)
- [ ] `reviewed_by` and `reviewed_at` are `"pending"`; `node scripts/check-community-plugins.mjs` reports only "not reviewed yet"
- [ ] `node scripts/verify-plugins.mjs --community <name> --graphrt <binary>` passes
  - Output:
- [ ] The tarball root has an `icon.svg` that passes the icon allowlist (or I accept the neutral fallback)
- [ ] README at the repository root with env vars, credentials, scopes, pricing, agent policy and errors
- [ ] My tests pass; one live run with an invalid credential
  - Result (exact error):
- [ ] `status` / `tos_risk` chosen per CONTRIBUTING.md (`tos_notes` for medium or high)

**Reviewer (maintainer) checklist**
- [ ] Read the source at the tag, and diffed against the previous reviewed tag for a new version
- [ ] Tarball contents match the tagged source plus production dependencies
- [ ] Agent-safety checklist holds; no stdout writes; no credentials as arguments; dependencies justified
- [ ] Publisher and display name are honest (no impersonation)
- [ ] Replaced `pending` with `reviewed_by` (your login) and `reviewed_at` (today) before merging

## Notes for reviewers
<!-- Judgement calls, API facts you could not verify, known gaps. -->
