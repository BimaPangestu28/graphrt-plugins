# libur-nasional

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for Indonesian public holidays: national holidays
(*libur nasional*) and collective leave (*cuti bersama*) from 2011 to next year. It lists holidays, checks a date,
finds the next holidays and counts working days between two dates. No account or API key is needed, and each year
is fetched once and cached in memory. Every operation is a workflow node and an agent tool.

## Data source and provenance
- **Official source:** the yearly joint decree of three ministers (*SKB 3 Menteri*: Menteri Agama, Menteri
  Ketenagakerjaan and Menteri PANRB), published as a PDF (for 2026: SKB No. 1497/2025, 2/2025 and 5/2025, signed
  19 September 2025; summary at [JDIH Kemenko Infrastruktur](https://jdih.kemenkoinfra.go.id/en/pemerintah-tetapkan-hari-libur-nasional-dan-cuti-bersama-tahun-2026)).
  **There is no official government API.**
- **What the plugin reads:** the public JSON API of the open-source **api-hari-libur** project,
  `https://api-hari-libur.pages.dev/api?year=YYYY` (MIT; source
  [ai-hana-ai/api-hari-libur](https://github.com/ai-hana-ai/api-hari-libur), a maintained fork of
  [radyakaze/api-hari-libur](https://github.com/radyakaze/api-hari-libur); its data credits
  [tanggalans.com](https://www.tanggalans.com/)). Each item is `{name, date, is_national_holiday}`;
  `is_national_holiday: false` marks cuti bersama.
- **Checked:** for 2026 the source lists exactly the SKB's 16 national holidays and 8 cuti bersama days
  (checked 2026-11-19). Other sources were rejected: Nager.Date omits the lunar-calendar holidays and cuti bersama,
  tallyfy.com had wrong 2026 dates, the original `libur.deno.dev` and `dayoffapi.vercel.app` deployments are offline.
- **Caveats:** this is a community dataset, not the decree. Next year's cuti bersama usually appears only after its
  SKB is signed (around September), and the government sometimes amends dates mid-year; for legal or payroll
  decisions, confirm against the SKB. Holidays declared only regionally (e.g. Nyepi-related days in Bali) and
  ad-hoc election holidays may be missing or late.
- **Unknown cuti bersama:** a year with no cuti bersama records in the source, or any year after the current one
  in Asia/Jakarta (its SKB may be missing or amended), is reported with `cuti_bersama_known: false`. `check_date`
  then returns `is_working_day: null` plus a `note` for a weekday that is not a national holiday, and
  `count_working_days` returns `uncertain: true`, `uncertain_years` and a `note` (its `working_days` may be too
  high) unless `cuti_bersama_is_day_off: false`.
- **Validation:** source items without a real `YYYY-MM-DD` date in the requested year, without a string `name` or
  without a boolean `is_national_holiday` are dropped; a year with no valid items is not cached. Dates must be in
  2011 to 2100.
- **Years without data:** for the current year or earlier, an empty or invalid list is an `api_error`. A later
  year that is out of range, empty or invalid counts as "no data yet": `next_holidays` returns this year's holidays
  plus a `coverage_note`, and `count_working_days` subtracts no holidays for it and returns `uncertain: true` with
  that year in `uncertain_years` (also with `cuti_bersama_is_day_off: false`).
- **Self-hosting:** set `LIBUR_NASIONAL_API_URL` to your own deployment of api-hari-libur (or any https service with
  the same `/api?year=` contract) to remove the dependency on the public instance.

## Features
- **`list_holidays`:** the holidays of a year (default: the current year in Asia/Jakarta), optionally one `month`
  and one `kind` (`libur_nasional` or `cuti_bersama`). Items: `date`, `name`, `is_national_holiday`, `kind`.
- **`check_date`:** whether a date (default: today in Asia/Jakarta) is a national holiday, cuti bersama, a weekend
  or a working day, with the day name in English and Indonesian (`hari`) and the holiday names.
- **`next_holidays`:** the next `count` holidays from a date (default today), across the year boundary, with
  `days_away`; `include_cuti_bersama: false` for national holidays only. When next year is not published yet (or
  its list is empty or invalid), `coverage_note` says so instead of failing.
- **`count_working_days`:** Monday to Friday between two dates (both included), minus national holidays and, by
  default, cuti bersama (`cuti_bersama_is_day_off: false` counts them as working days; civil servants take them,
  private employers often do). Returns calendar, weekend and working days plus the weekday days off. At most 3
  calendar years per call.
- **`api_request`:** the source's other endpoints, e.g. `/api/today`, `/api/tomorrow` or
  `/api?year=2026&month=3&day=21` (GET only for agents)

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js >= 20, graphrt with plugin support
- Network access to `api-hari-libur.pages.dev` (or your `LIBUR_NASIONAL_API_URL`)

## Installation
```bash
graphrt plugin install ./libur-nasional
```
No `npm install` needed: the plugin has no dependencies.

## Configuration
| Variable | Required | Description |
|---|---|---|
| `LIBUR_NASIONAL_API_URL` | no | Base URL of the holiday API (https only; default `https://api-hari-libur.pages.dev`) |
| `LIBUR_NASIONAL_CACHE_TTL_SECONDS` | no | How long a year's list is cached in memory (default `21600`, 6 hours; `0` turns the cache off) |

**Caching:** each year is one request, cached per base URL and year for the plugin process's lifetime (up to 64
years); concurrent calls share one request, and failed requests are not cached. Every operation reads from the
same cache, so checking many dates or counting working days costs one request per year.

**Limits:** the public instance states no rate limit; the cache keeps traffic to a few requests a day.

## Quick Start
```bash
graphrt run libur-nasional/example.yaml --plugins .
```
The example checks today, lists the next three holidays and counts December 2026's working days.

## Usage
```yaml
- id: lebaran
  type: libur-nasional.list_holidays
  year: 2026
  month: 3
- id: deadline_ok
  type: libur-nasional.check_date
  date: "{{#start.deadline#}}"
- id: sla
  type: libur-nasional.count_working_days
  start_date: "{{#start.opened_on#}}"
  end_date: "{{#start.closed_on#}}"
  cuti_bersama_is_day_off: false
```

## Agent policy
All operations are public reads and are available to agents as tools. `api_request` is GET-only for agents. Tool
results are truncated at 100,000 characters (nodes get everything).

## Errors
- `invalid_input`: a date that is not a real `YYYY-MM-DD` or outside 2011 to 2100, `end_date` before `start_date`, a range over 3 years,
  a year the source does not cover (its message, e.g. "Maximum year is 2027" or "Minimum year is 2011"), an http
  `LIBUR_NASIONAL_API_URL`, or a `LIBUR_NASIONAL_CACHE_TTL_SECONDS` that is not a whole number
- `api_error` / `network_error`: the source is down or returned no valid holidays for the year (reads are retried; failures are not cached)

## Testing
```bash
npm test          # from the repo root
```
`test/contract.test.mjs` runs the generated contract suite plus cache, default-date, cross-year and working-day
cases; `test/holiday-calendar.test.mjs` and `test/holiday-cache.test.mjs` cover the date logic and the cache.
Verified live with a real read (`graphrt run libur-nasional/example.yaml --plugins .`).

## License
Apache-2.0. Holiday data: api-hari-libur (MIT), based on the SKB 3 Menteri.
