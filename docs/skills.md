# Agent skills in the catalog

A skill gives a graphrt agent instructions it loads only when a task needs them: a `SKILL.md` file in the
[Agent Skills](https://agentskills.io/specification) format, with optional reference files. graphrt reads skills
(see `docs/skills.md` in [Graphrt/graphrt](https://github.com/Graphrt/graphrt)) and Graphrt Desktop offers the
catalog's skills under **Skills › From the catalog**.

This repository holds the catalog's skills in `skills/`, checks them, and publishes them through the same signed
catalog as the plugins.

- [Adding a skill](#adding-a-skill)
- [SKILL.md](#skillmd)
- [Rules](#rules)
- [Changing a skill](#changing-a-skill)
- [How a skill is released](#how-a-skill-is-released)
- [The catalog entry](#the-catalog-entry)

## Adding a skill

1. Create `skills/<name>/SKILL.md`. `<name>` is 1 to 64 of `a-z`, `0-9` and single hyphens, and is the skill's
   `name`. Put longer material in reference files next to it (for example `references/table.md`) and point at
   them from the instructions; an agent reads them only when the instructions say so.
2. Write the frontmatter and the instructions (see [SKILL.md](#skillmd)). Write it yourself: do not copy a skill
   or a document you have no right to publish under this repository's license.
3. Run the checks and look at what would be published:
   ```bash
   npm run check          # validates every skill (node scripts/check-skills.mjs)
   npm run pack:skills    # writes dist/skills/skill-<name>-<version>.tar.gz and prints the catalog entry
   ```
4. Open a pull request. CI runs the same checks. A maintainer reads the skill as an agent would: instructions an
   agent could follow into harm (sending, paying, deleting or sharing without a person's say) are not accepted,
   whatever the checks say.

Add a row to the Skills table of the root [README](../README.md#skills). Nothing else is needed: there is no
manifest, no icon and no registry entry. A skill appears in the catalog with the next publish after the pull
request is merged.

**What makes a good catalog skill**

- It needs no tool, or only tools of plugins in this repository (`allowed-tools`, below).
- The `description` says what the skill does **and when to use it**: the agent sees only the name and the
  description when it decides whether to load the skill.
- The instructions tell the agent what to do when information is missing (ask, or mark it), and which decisions
  stay with a person.
- It is written in the language its users work in. The starter skills are in Indonesian.

## SKILL.md

```markdown
---
name: kebijakan-refund
description: Menilai permintaan refund, retur atau tukar barang berdasarkan kebijakan toko. Gunakan saat pelanggan meminta uang kembali.
license: Apache-2.0
metadata:
  version: "1.0.0"
  display_name: Kebijakan Refund dan Retur
  author: graphrt
allowed-tools: shopify/get_order
---

# Menilai permintaan refund

1. Kumpulkan nomor pesanan dan tanggal barang diterima.
2. Pegangan umum ada di references/matriks-keputusan.md.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The directory name |
| `description` | yes | What the skill does and when to use it, on one line, at most 1,024 characters, no markup tags |
| `metadata.version` | yes | Semver, **quoted** (`"1.0.0"`): the catalog `version`, which the desktop app compares to offer an update |
| `metadata.display_name` | yes | The name people see, 1 to 60 characters: the catalog `display_name` |
| `metadata.author` | no | Free text |
| `license` | no | License name. Skills in this repository are published under its [license](../LICENSE) |
| `compatibility` | no | Free text, at most 500 characters |
| `allowed-tools` | no | Tools the skill would like to use, as `plugin/tool` or `plugin/*`, space-separated or as a list |

`version` and `display_name` live in `metadata` because the specification has no such fields; graphrt reads
`metadata.version` as the skill's version.

**Frontmatter subset.** The catalog tooling does not use a YAML parser. The frontmatter must be written in the
small subset shown above, which every YAML reader understands the same way, so what is checked here is exactly
what graphrt reads after the install: one `key: value` per line, `metadata` as lines indented by two spaces, and
`allowed-tools` on one line or as `  - item` lines. A value that contains `: ` or ` #`, or that YAML would read as
a number, boolean or date, is quoted (`"..."` with only `\"` and `\\` escapes, or `'...'`). Comments, multi-line
values (`|`, `>`), unknown fields, tabs and CRLF line endings are refused with the line number.

**Tools.** A tool a skill asks for is never granted by the catalog. The person who installs the skill ticks the
tools it may use, and an update starts from nothing ticked again. A request must name a tool of a plugin in this
repository (`gmail-api/send_message`, `google-sheets/*`); the check refuses anything else, including other
products' syntax such as `Bash(git:*)`.

## Rules

`node scripts/check-skills.mjs` enforces these on the sources, and the publish enforces them again on the archive
it lists. Where graphrt allows more, the catalog is stricter on purpose.

| Rule | Catalog | graphrt accepts |
| --- | --- | --- |
| `skills/` holds only skill directories, each with a `SKILL.md` | yes | n/a |
| `SKILL.md` length | 24,000 characters | 256 KiB (an agent's tool result is cut at 32,000 characters by default) |
| Files per skill | 32 | 256 |
| One file | 256 KiB | 1 MiB |
| All files | 1 MiB | 8 MiB |
| Directory depth | 5 | 5 |
| File types | `.md`, `.txt`, `.csv`, `.json`, UTF-8 text, LF line endings | any |
| `scripts/` directory, executable files, links | refused | scripts are kept as text and never run |
| `package.json`, `plugin.json`, `hooks.json`, `mcp.json`, `graphrt-plugin.json` | refused | part of other package formats |
| Dotfiles, key material, `.env`, Windows device names, names differing only in case | refused | mostly refused |
| Invisible or text-reordering characters, in any file | refused | install stops until accepted |
| "Download and run" commands | refused | install stops until accepted |
| Wording the install-time scan warns about (set aside instructions, hide from the user, act without approval, credential files) | refused | shown as a warning |
| Tool requests | a tool of a plugin in this repository | any `provider/tool` |
| Archive | at most 8 MiB (what the desktop app downloads) | n/a |

**No code runs at build time.** Packing a skill reads its git-tracked files and writes them into a `.tar.gz` with
the repository's own deterministic tar writer. No dependency is installed, no hook or script of the skill is
executed, and the validator only reads bytes. A skill cannot ship anything executable in the first place.

## Changing a skill

A published skill version is never modified. To ship a change, **bump `metadata.version`** in the same pull
request. Without a bump the publish keeps listing the published archive and logs that the local build differs.

Removing a skill directory removes the skill from the next catalog; its releases stay, and installed copies keep
working.

## How a skill is released

Maintainers release; contributors never tag or publish.

- Every run of [`release.yml`](../.github/workflows/release.yml) that publishes (a plugin tag, a manual run)
  also releases each skill whose version has no release yet. To release skills without touching any plugin, push
  the tag `skill-<name>-v<version>`: the workflow checks it against `metadata.version` and runs
  `node scripts/publish-plugins.mjs --skills-only`, which tests, packs and releases no plugin. Like
  `--catalog-only`, it rebuilds the plugin entries from what is published and refuses when that would drop or
  change a listed plugin (for example while a plugin's version bump is merged but not released yet: release the
  plugin first).
- A skill version is the GitHub Release `skill-<name>-v<version>` with the asset
  `skill-<name>-<version>.tar.gz`. The archive holds one directory `<name>/` with the skill's files. No plugin
  (official or community) may have a name starting with `skill-`.
- The publish packs the skill, reads the archive back with the strict tar reader and the validator, creates the
  release when there is none, and then describes the **published** archive (downloaded again when it already
  existed) to build the catalog entry. `index-v2.json` is signed together with the plugins and uploaded as
  before; `SHA256SUMS` lists the skill archives too.
- A skill that fails its checks is skipped: the run shows an error annotation and the summary lists it under
  `skipped` with `"kind": "skill"`. It never fails a plugin publish. Pull requests get the strict check, so `main`
  should only ever hold valid skills.
- `--catalog-only` creates no release. It lists the skills already published and refuses when a skill of the
  live catalog would be dropped or would change version, checksum, size or URL.
- `--dry-run` packs and checks everything and creates and uploads nothing.

## The catalog entry

Skills are the `skills` list of the signed `index-v2.json`, next to `plugins`:

```json
{"schema": 2, "generated_at": "2026-11-27T10:00:00Z", "plugins": ["..."], "skills": [{
  "name": "kebijakan-refund",
  "display_name": "Kebijakan Refund dan Retur",
  "version": "1.0.0",
  "description": "Menilai permintaan refund, retur atau tukar barang ...",
  "tarball_url": "https://github.com/Graphrt/graphrt-plugins/releases/download/skill-kebijakan-refund-v1.0.0/skill-kebijakan-refund-1.0.0.tar.gz",
  "sha256": "<hex of the archive>",
  "size_bytes": 3535,
  "publisher": "graphrt"}]}
```

| Field | From |
| --- | --- |
| `name`, `description` | `SKILL.md` inside the published archive |
| `display_name`, `version` | `metadata.display_name`, `metadata.version` of that `SKILL.md` |
| `tarball_url` | The archive, an asset of a release of this repository |
| `sha256`, `size_bytes` | The published archive's bytes |
| `publisher` | `graphrt` |

This is the format graphrt-builder-desktop reads. It verifies the index signature before parsing, accepts only
`https` archive links under this repository's release assets, checks `sha256` on the download, and unpacks the
archive expecting the single top-level directory `<name>/`; then graphrt's own install checks and scan run.

- The list is sorted by name. A publish always writes the field, as `[]` when there is no skill.
- `skills` is an additive field of schema 2: a reader that does not know it ignores it, and the `plugins` list is
  byte for byte what it would be without skills.
- `index.json` (schema 1, for older apps) does not list skills. No reader of v1 knows skills, and v1 has little
  room left under its 2 MiB limit.
- The signed trusted comment is unchanged (`plugins=<count> generated_at=<time>`).
