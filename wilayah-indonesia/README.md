# wilayah-indonesia

**Status:** stable · **ToS risk:** none. Public no-auth API; the example read real data live (rechecked 2026-11-19). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for Indonesian administrative regions with their
Kemendagri codes: 38 provinces → 514 regencies/cities → 7,285 districts (kecamatan) → 83,762 villages (desa and
kelurahan). It lists the hierarchy, looks up a code with its parents and full address, and searches by name. No
API key.

## Data source and provenance
- **Dataset:** [`db/wilayah.sql`](https://github.com/cahyadsn/wilayah/blob/master/db/wilayah.sql) of
  [cahyadsn/wilayah](https://github.com/cahyadsn/wilayah) (MIT, actively maintained, ~1,300 stars), the source
  also used by [wilayah.id](https://wilayah.id/).
- **Legal basis:** Keputusan Menteri Dalam Negeri **No 300.2.2-2138 Tahun 2025** on administrative region codes
  and data, plus the maintainer's later corrections (latest: 2026-02-13, a village name). The repository's island
  data follows the amending Kepmendagri No 300.2.2-2430 Tahun 2025; the region file is labelled 2138.
- **Pinned version:** commit `d68e8d5516f969d1905d0b2940f20034becb0db7` (the last change to `db/wilayah.sql`), fetched
  from `https://raw.githubusercontent.com/cahyadsn/wilayah/<ref>/db/wilayah.sql` (~3 MB). Pinning keeps results
  stable; set `WILAYAH_INDONESIA_DATA_REF=master` to follow upstream.
- **Why not an API:** Kemendagri publishes the decree as a PDF, not an API. Public JSON APIs exist
  (wilayah.id: same data per 2138, no search; emsifa/api-wilayah-indonesia: older data), but none offers name
  search, so the plugin loads the whole dataset once and answers every call from memory.

Codes are Kemendagri codes (`32.73.07.1001`), not BPS codes (which differ below the regency level). Every code
argument accepts dots or plain digits (`3273071001`). A village's 4-digit part starts with `1` for a kelurahan and
`2` for a desa (`type`).

## Features
- `list_provinces`, `list_regencies` (`province_code`), `list_districts` (`regency_code`), `list_villages`
  (`district_code`)
- `get_region`: name, level, `type` for villages, `parents`, `address` ("Pasteur, Sukajadi, Kota Bandung, Jawa
  Barat") and `child_count`
- `search_regions`: case- and accent-insensitive, every word of `query` must appear in the name; exact names first
  (also without "Kabupaten"/"Kota"), then prefixes, word prefixes and other matches; higher levels first on ties;
  filter by `level` and `within_code`; `limit` (default 20, max 100); returns `{regions, total_matches}`

Full reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `raw.githubusercontent.com` (first call per process, or when the cache expires)

## Installation
```bash
graphrt plugin install ./wilayah-indonesia
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `WILAYAH_INDONESIA_DATA_REF` | no | Commit SHA, tag or branch of cahyadsn/wilayah (default: the pinned commit above) |
| `WILAYAH_INDONESIA_DATA_SHA256` | no | Expected SHA-256 (64 hex) of `wilayah.sql` for the chosen ref; overrides the built-in hash of the pinned commit |
| `WILAYAH_INDONESIA_CACHE_DIR` | no | Absolute directory for a disk copy of the dataset, so new processes skip the download |
| `WILAYAH_INDONESIA_CACHE_TTL_HOURS` | no | Refresh a branch/tag copy after this many hours (default 24); a commit SHA never expires |

**Caching:** the parsed dataset stays in memory for the life of the plugin process (one download, ~1-2 s, shared by
concurrent calls; a failed download is not remembered). With `WILAYAH_INDONESIA_CACHE_DIR` the file is also written
there (atomically) and reused. A download that does not parse into at least 30 provinces (an error page, a
truncated file) is refused and never cached.

**Integrity:** the pinned commit's file must have SHA-256
`c4c3396d9380d4edee072af1d9dff83573b574d7cd00a6562cf82e200e954031`, checked on every download and on every read of
the disk cache. A download with another hash is refused (`api_error`, not cached); a cache file with another hash is
ignored (logged to stderr), downloaded again and replaced. Another `WILAYAH_INDONESIA_DATA_REF` has no known hash:
set `WILAYAH_INDONESIA_DATA_SHA256` to check it (e.g. `curl -sL <url> | shasum -a 256` for a commit you reviewed);
without it, a branch or tag is only checked by the province count. The download is read as a stream and refused
past 20 MB (or a larger `Content-Length`), so an oversized body is never buffered whole.

## Quick Start
```bash
graphrt run wilayah-indonesia/example.yaml --plugins .
```
The example finds the district Coblong in Kota Bandung and lists its villages.

## Usage
```yaml
- id: place
  type: wilayah-indonesia.search_regions
  query: sukajadi
  level: district
  within_code: "32"
- id: detail
  type: wilayah-indonesia.get_region
  code: "{{#place.data.regions.0.code#}}"
```

## Agent policy
All operations are reads of public data and are agent tools. Nothing writes, sends or costs money. The plugin needs
no secrets and reads no files except its own optional cache directory.

## Errors
| Situation | Kind |
|---|---|
| A code that is not a Kemendagri shape, or of the wrong level (`list_districts` with a province code) | `invalid_input` |
| A well-formed code that does not exist | `not_found` |
| Bad `WILAYAH_INDONESIA_DATA_REF` or `WILAYAH_INDONESIA_DATA_SHA256`, or a relative cache directory | `invalid_input` (no request) |
| Unknown ref (GitHub 404) | `not_found` |
| A download that is not the dataset | `api_error` |
| A download with the wrong SHA-256, or over 20 MB | `api_error` (not retried, not cached) |
| Network failure or timeout (25 s per attempt) | `network_error` (retried twice) |

## License
Apache-2.0. Region data: MIT, copyright cahya dsn; based on Kepmendagri No 300.2.2-2138 Tahun 2025.
