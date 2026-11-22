# Publishing a community plugin

Community plugins live in their developers' own GitHub repositories and are listed in the official graphrt
catalog after a maintainer has reviewed them. Your code stays in your repository. This repo holds one entry
per plugin in [`community-plugins.json`](../community-plugins.json), and that entry pins the exact release a
maintainer reviewed.

The desktop app shows these plugins with `source: "community"`, your `publisher` name and your
`repository_url`, so users can tell them apart from the official ones.

## Contents
- [Trust model](#trust-model)
- [1. Scaffold the plugin](#1-scaffold-the-plugin)
- [2. Required files](#2-required-files)
- [3. Agent-safety checklist](#3-agent-safety-checklist)
- [4. Pack the tarball](#4-pack-the-tarball)
- [5. Release it on your GitHub](#5-release-it-on-your-github)
- [6. Open a pull request with one entry](#6-open-a-pull-request-with-one-entry)
- [What reviewers check](#what-reviewers-check)
- [After the merge: mirroring and publishing](#after-the-merge-mirroring-and-publishing)
- [New versions](#new-versions)
- [Removal and yanking](#removal-and-yanking)
- [Registry reference](#registry-reference)

## Trust model
- **We review the code at your tag and ship exactly those files.** The registry entry pins your tag and the
  sha256 of your release tarball. Publishing downloads the tarball, refuses it unless its sha256 matches, reads
  it with a strict tar parser, and **re-packs it canonically** with this repo's own tar writer (same paths, same
  bytes, executable bits kept; fixed mtime and headers). Your exact upload bytes are never shipped: the repack is
  what is checked, mirrored to a release of this repo named `community-<name>-v<version>`, and pinned by the
  catalog `sha256`. The catalog links only to that mirror, so if you later move the tag, replace the asset or
  delete your repo, users still get the reviewed files, and nothing else.
- **A mirror is immutable.** It is created once and never modified. Its release notes record the sha256 of the
  upload it was made from. If a mirror under that name was made from another upload, or does not hold a canonical
  repack, publishing refuses the entry. To ship a change, release a new version.
- **Every version is reviewed.** No version reaches the catalog without its own pull request and review. Nothing
  updates automatically.
- **Review is not a warranty.** A review lowers the risk; it does not remove it. Your status label (`beta`,
  `experimental`) and your ToS risk are shown to users as for official plugins, and the plugin runs with the
  permissions its manifest declares.

## 1. Scaffold the plugin
Start with the graphrt CLI:

```bash
graphrt plugin new acme-crm --lang typescript   # or python, rust
cd acme-crm && git init
```

For a Node plugin you can also copy the structure of an official one. [`open-meteo/`](../open-meteo/) is a
declarative REST plugin and [`meta-api/`](../meta-api/) is a hand-written one. If you build on `shared/lib`,
copy it into your repo, since your plugin must carry everything it runs.

**Name:** lowercase letters, digits and single hyphens (at most 64 characters, so no `_`). It must not match
any top-level directory of this repo, an official plugin or another community plugin. The name in your
manifest, the top-level directory in your tarball and the registry key must all be the same.

## 2. Required files
At the root of your plugin directory:

| File | Notes |
|------|-------|
| `graphrt-plugin.json` | `name`, a semver `version` and `nodes` (and `tools` when the plugin offers tools). Node config properties must not use names graphrt reserves (`id`, `type`, `title`, `timeout`, ...; see [`shared/lib/reserved-node-keys.mjs`](../shared/lib/reserved-node-keys.mjs)) |
| `plugin.mjs` | The entrypoint (`command: "node"`, `args: ["plugin.mjs"]`). It must never write to stdout except the JSON-RPC protocol |
| `README.md` | The same sections official plugins have (see [CONTRIBUTING.md](../CONTRIBUTING.md#readmemd)): overview, env vars, credentials, scopes, pricing, agent policy, errors. A `> **Warning:**` blockquote becomes the catalog `warning`. The catalog links the README at your tag (`<repository_url>/blob/<tag>/README.md`), so keep one at the repository root |
| `icon.svg` | 24×24 SVG, at most 8 KB, that passes the [icon allowlist](icons.md#svg-allowlist). Use a brand mark only if you own it or its licence allows it. If the icon is missing or rejected, the catalog uses a neutral puzzle glyph |
| `package.json` + `package-lock.json` | Only if you have npm dependencies (production dependencies are bundled into the tarball) |
| `LICENSE` | Any OSI-approved licence |

Tests, an `example.yaml` that runs a **read** operation, and CI in your repo are expected (see
[CONTRIBUTING.md](../CONTRIBUTING.md#tests)). Reviewers run them.

## 3. Agent-safety checklist
Community plugins follow the same rules as official ones. Work through the
[agent-safety checklist](../CONTRIBUTING.md#agent-safety-checklist) and state each decision in your README.
In short:
- money movement, deletes, bulk or admin operations are node only;
- sends, posts and writes from tools need an opt-in env, plus recipient or target allowlists;
- paid calls are never retried;
- no callback URLs on tools;
- `api_request` is GET-only for tools;
- secrets are stripped from tool results, and no credential is ever accepted as an argument;
- local files only inside allowlisted directories;
- downloads go over https to public hosts, with caps and timeouts.

Credentials come only from environment variables listed in `permissions.env`.

## 4. Pack the tarball
The tarball must look exactly like an official release tarball:

```
<name>-<version>.tar.gz
└── <name>/                     the only top-level entry, a directory
    ├── graphrt-plugin.json     with "checksums": {"<path>": "<sha256 hex>", ...}
    ├── plugin.mjs              pinned in checksums (required)
    ├── icon.svg                (not pinned; checked against the allowlist)
    ├── README.md
    ├── lib/...                 every .mjs/.js/.cjs/.json outside node_modules is pinned
    └── node_modules/...        production dependencies only, no .bin directories (not pinned)
```

The tarball may contain only regular files and directories: no symlinks, hard links or device files. Paths
may not be absolute and may not contain `..`. It must not contain `.env*`, `.git`, `.claude`, `.cache`,
`.DS_Store`, browser profiles, Playwright browser downloads or key material (`*.pem`, `*.key`, `*.p12`). The
compressed tarball may be at most 64 MiB, and at most 256 MiB unpacked.

The easiest way to get this right is this repo's packer. Run it from a clone of graphrt-plugins against your
plugin directory, which must be a git repository. Only files git tracks are packed; `test/` and dotfiles are
left out:

```bash
git clone https://github.com/BimaPangestu28/graphrt-plugins && cd graphrt-plugins
node scripts/pack-plugins.mjs --plugin-dir ../acme-crm --out ../acme-crm/dist
# -> <sha256>  acme-crm-1.2.0.tar.gz  (... bytes, N pinned files)
node scripts/verify-plugins.mjs ../acme-crm/dist/acme-crm-1.2.0.tar.gz --graphrt "$(which graphrt)"
```

The packer runs `npm ci --omit=dev --ignore-scripts` when you have dependencies, adds the `checksums` and writes
a reproducible archive. The printed sha256 is the `tarball_sha256` of your registry entry.

## 5. Release it on your GitHub
1. Commit everything and tag the commit you want reviewed, `v<version>` (or `<version>`), for example `v1.2.0`.
   The tag must name the same version as `graphrt-plugin.json`.
2. Create a GitHub release for that tag and upload the tarball as an asset named exactly
   `<name>-<version>.tar.gz`. Your repository must be public.
3. Do not replace the asset or move the tag afterwards. The review pins the bytes, so a changed asset is
   refused.

## 6. Open a pull request with one entry
Add one entry to [`community-plugins.json`](../community-plugins.json), keeping the file sorted by name:

```json
{
  "acme-crm": {
    "repository_url": "https://github.com/acme/graphrt-acme-crm",
    "tag": "v1.2.0",
    "tarball_url": "https://github.com/acme/graphrt-acme-crm/releases/download/v1.2.0/acme-crm-1.2.0.tar.gz",
    "tarball_sha256": "<the sha256 the packer printed>",
    "publisher": "Acme Inc.",
    "display_name": "Acme CRM",
    "status": "beta",
    "status_reason": "Official Acme API; reviewed at v1.2.0, checked live only with an invalid key.",
    "tos_risk": "none",
    "reviewed_by": "pending",
    "reviewed_at": "pending"
  }
}
```

Leave `reviewed_by` and `reviewed_at` as `"pending"`. The reviewing maintainer replaces them with their GitHub
login and the review date before merging. `npm test` and `npm run check` validate the file, so CI stays red
with "not reviewed yet" until then. That is expected, and it means an unreviewed entry cannot be merged by
accident.

Then check the entry yourself:

```bash
node scripts/check-community-plugins.mjs                 # schema (only "not reviewed yet" may remain)
node scripts/verify-plugins.mjs --community acme-crm     # downloads your asset and runs every publish check
```

`verify-plugins.mjs --community` accepts `pending` review fields, and says so in its output.

Use the **Community plugin** section of the pull request template. Remove the sections meant for official
plugins. The PR changes only `community-plugins.json`.

## What reviewers check
1. **The code at your tag.** Reviewers read the source at `tag`, and what is in the tarball (the tarball must
   match the tagged source plus production dependencies). They check correctness against the provider's
   official docs, every item of the agent-safety checklist, error handling, credential handling, logging (no
   stdout, no secrets) and dependencies (necessary, maintained, locked).
2. **The tarball.** `verify-plugins.mjs --community` must pass. It covers the sha256, the layout, safe paths,
   forbidden files and key material, checksums, the name and version against the entry and tag, pinned code,
   reserved parameters and the icon. With `--graphrt` it also checks that graphrt accepts the plugin.
3. **Tests and a live check.** Your tests pass, and one run of `example.yaml` with an invalid credential returns
   a clean `auth_error` (or a real read for a public no-auth API).
4. **Labels.** `status` and `tos_risk` follow the same rules as official plugins
   ([status labels](../CONTRIBUTING.md#status-labels)). `medium` and `high` need `tos_notes` with the clauses
   and mitigations.
5. **Listing.** The `publisher` and `display_name` are honest. You may not impersonate a provider, use "graphrt"
   as a publisher, or use a brand you do not own in a way that suggests endorsement.

## After the merge: mirroring and publishing
A maintainer runs the release workflow (or `node scripts/publish-plugins.mjs`). For each entry, the publish:

1. validates the entry;
2. uses the mirror release `community-<name>-v<version>` when it exists. Otherwise it downloads `tarball_url`
   over https (GitHub hosts only, size-capped);
3. verifies `tarball_sha256` **before** reading or extracting anything;
4. reads the tarball with the strict tar parser (duplicate or case-variant paths, PAX keys other than `path`,
   links, non-octal sizes, bad checksums, data after the end of the archive and multi-member gzip are refused)
   and re-packs it canonically;
5. runs the checks listed above on the repack (and `graphrt plugin install` when enabled, see below);
6. creates the mirror release with the repack, if it does not exist yet. An existing mirror is never
   modified;
7. adds the plugin to `index.json`, `index-v2.json` and its immutable detail file
   `plugin-<name>-<version>.json`, and uploads its icon to the `catalog` release.

An entry that fails any step is skipped with its reason in the publish output, and the rest of the catalog
still publishes. `--catalog-only` lists community plugins too, but only from tarballs that are already
mirrored.

## New versions
Every new version needs a new pull request that updates your entry: the new `tag`, `tarball_url` and
`tarball_sha256`, any label changes, and a short changelog in the PR. It gets a fresh review of the diff
since the last reviewed tag. Older mirror releases stay, but the catalog lists only the version in the entry.

## Removal and yanking
- **You want to unlist the plugin:** open a PR that removes your entry. The next publish drops it from the
  catalog. Users who installed it keep their copy, but the app no longer offers it or updates it.
- **A version is broken or unsafe (yank):** a maintainer removes the entry, or points it back at an earlier
  reviewed version, and republishes the catalog (`--catalog-only` is enough). For a security problem,
  maintainers may also delete the mirror release so the tarball URL stops resolving, and will tell you.
  Report security issues privately to the maintainers, not in a public issue.
- **The maintainers may remove an entry** if the plugin breaks the agent-safety rules, its provider's terms
  change, the repository disappears, or reports go unanswered.

## Registry reference
`community-plugins.json` is a JSON object keyed by plugin name. Every field is a string with no surrounding
whitespace and no control or bidi characters. `scripts/lib/community-plugins.mjs` enforces these rules:

| Field | Rule |
|-------|------|
| key (name) | `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 characters, not a top-level directory of this repo (every official plugin), and `community-<name>` not an official plugin |
| `repository_url` | `https://github.com/<owner>/<repo>`, no trailing slash or `.git`, ≤ 300 characters |
| `tag` | `v<semver>` or `<semver>`, ≤ 64 characters; the version is the tag without `v` |
| `tarball_url` | exactly `<repository_url>/releases/download/<tag>/<name>-<version>.tar.gz` |
| `tarball_sha256` | 64 lowercase hex characters |
| `publisher` | ≤ 60 characters, must not contain "graphrt" |
| `display_name` | ≤ 60 characters |
| `status` | `stable`, `beta` or `experimental` |
| `status_reason` | ≤ 500 characters |
| `tos_risk` | `none`, `low`, `medium` or `high` |
| `tos_notes` | optional, ≤ 2000 characters, required for `medium` and `high` |
| `reviewed_by` | the reviewing maintainer's GitHub login (`pending` until the review; refused by the checks and by publishing) |
| `reviewed_at` | review date, `YYYY-MM-DD` (`pending` until the review) |

Unknown fields are refused.
