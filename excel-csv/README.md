# excel-csv

**Status:** stable · **ToS risk:** none. Local only; its example workflow ran on real files during the build (PR #40). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **local CSV/TSV and Excel (.xlsx) files**. Workflows
and agents can list a workbook's sheets, read rows (a sheet, an A1 range, a header row, a row cap), write rows to a
new CSV or XLSX file, and convert between the two. It uses [exceljs](https://github.com/exceljs/exceljs) and
[csv-parse/csv-stringify](https://csv.js.org/). Every result is a new file in one output directory.

## Features
- **`list_sheets`:** name, 1-based index, visibility (`visible`, `hidden`, `veryHidden`) and used row/column counts.
- **`read`:** rows as objects keyed by the header row (`header_row`, default 1; 0 for none) or as arrays, from a CSV
  (delimiter auto-detected: `,` `;` tab `|`; tab for `.tsv`) or an XLSX `sheet` (name or index) and `range`
  (`A1:F200`). Formula cells give their saved results, dates come as ISO strings, rich text as plain text. Empty or
  duplicate header names become `column_N` / `name_2`. `max_rows` (default 1000) with a `truncated` flag.
- **`write`:** `rows` as objects (keys become columns, or set `columns`) or arrays, to CSV or XLSX (`sheet_name`).
- **`convert`:** CSV/TSV → XLSX (decimal text becomes numbers, `007` stays text, or `keep_text: true`) and XLSX sheet →
  CSV.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer.
- `npm install` in this directory (`exceljs` 4.4.0, `csv-parse` 7.0.3, `csv-stringify` 6.9.0; `uuid` is overridden
  to 11.1.1 to clear an advisory in exceljs's pinned 8.x). Without it calls return `setup_required`.

## Installation
```bash
cd excel-csv && npm install && cd ..
graphrt plugin install ./excel-csv
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `EXCEL_CSV_INPUT_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that files may be read from, subdirectories included |
| `EXCEL_CSV_OUTPUT_DIR` | (none) | Existing directory for outputs. Without it only `list_sheets` and `read` work. Outputs can be read back as inputs. |
| `EXCEL_CSV_MAX_INPUT_BYTES` | 50 MiB | Largest input file |
| `EXCEL_CSV_MAX_OUTPUT_BYTES` | 100 MiB | Largest output; nothing is written above it |
| `EXCEL_CSV_MAX_ROWS` | `100000` | Most rows per read, write or conversion |
| `EXCEL_CSV_MAX_UNZIPPED_BYTES` | 300 MiB | Most bytes an .xlsx may declare it unpacks to (zip-bomb check) |
| `EXCEL_CSV_MAX_COLUMNS` | `1000` | Most columns read; wider rows are cut (`truncated: true`) |
| `EXCEL_CSV_MAX_CELLS` | `500000` | Most cells (rows × width, counted before padding) read in one call |
| `EXCEL_CSV_MAX_RESULT_BYTES` | 50 MiB | Most (estimated) bytes of cell values read in one call |
| `EXCEL_CSV_MAX_MEMORY_MB` | `1024` | Memory budget of the parsing worker: heap cap and resident-memory (RSS) watchdog |
| `EXCEL_CSV_TIMEOUT_MS` | `60000` | Per parse (1000 to 100000); the worker is killed when it passes |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

## Quick Start
```bash
mkdir -p ~/tables/in ~/tables/out
printf 'name,price\nkopi,15000\nteh,8000\n' > ~/tables/in/products.csv
export EXCEL_CSV_INPUT_DIRS=~/tables/in EXCEL_CSV_OUTPUT_DIR=~/tables/out
graphrt run excel-csv/example.yaml --plugins .
```

## Usage
A `read` result:
```json
{ "path": "/Users/me/tables/in/products.csv", "format": "csv", "sheet": null, "delimiter": ",", "columns": ["name", "price"],
  "rows": [{ "name": "kopi", "price": "15000" }, { "name": "teh", "price": "8000" }], "row_count": 2, "truncated": false }
```
CSV values are read as text; XLSX values keep their types. `output_name` sets the start of a generated output name; a
UTC timestamp and random suffix are always added.

## Safety
- **CSV injection:** when writing CSV, cells that start with `=`, `+`, `-`, `@`, tab or CR get a leading `'`, so
  Excel, LibreOffice or Google Sheets show them as text instead of running them (`=HYPERLINK(...)`, DDE). Plain
  signed numbers such as `-5` or `+1.25` are left as they are. Only a
  workflow node may pass `csv_injection_protection: false`; a tool call that tries gets `permission_denied`.
  XLSX output always stores literal values, never formulas.
- **Zip bombs:** before an .xlsx is unpacked, its zip directory is read and refused if it declares more than
  `EXCEL_CSV_MAX_UNZIPPED_BYTES` or 10000 parts. A zip that lies about its sizes fails on the size mismatch inside
  the worker.
- **Parsing in a worker:** CSV and XLSX parsing runs in a short-lived child process with a memory budget
  (`EXCEL_CSV_MAX_MEMORY_MB`, enforced as the V8 heap cap and by an RSS watchdog polling every 50 ms), a timeout and
  cancel, all ending in SIGKILL. A crafted file can only exhaust that process, never the plugin.
- **Cell budget:** only cells that exist are read (one value at XFD1 does not make every row 16384 wide), rows are
  cut to `EXCEL_CSV_MAX_COLUMNS` while parsing, and the budget (`EXCEL_CSV_MAX_CELLS` of rows × width,
  `EXCEL_CSV_MAX_RESULT_BYTES`) is charged before rows are padded to a common width. A read that hits it returns
  what fits with `truncated: true`; a `convert` that hits it fails instead of writing a partial file.
- **Files:** inputs must be regular `.csv`, `.tsv`, `.txt` or `.xlsx` files inside `EXCEL_CSV_INPUT_DIRS` (or the
  output directory), checked after `realpath` on both sides with a separator-suffixed prefix; symlinks out, `../`,
  FIFOs, devices and files with more than one hard link are refused, and a file outside the allowlist gets the same
  `not_found` as a missing one.
- **Outputs:** always new files with generated names, created exclusively (`wx`), never overwriting anything.
- **Caps:** rows (`EXCEL_CSV_MAX_ROWS`), 1000 columns per written row, 1 MB per CSV record.
- **Agents vs nodes:** all operations are tools; they only read allowlisted files and add new files to the output
  directory (setting `EXCEL_CSV_OUTPUT_DIR` is the opt-in for writing).

## Errors
| Kind | When |
|------|------|
| `setup_required` | npm packages not installed, `EXCEL_CSV_INPUT_DIRS` or (for outputs) `EXCEL_CSV_OUTPUT_DIR` unset |
| `not_found` | The file is missing or outside the allowed directories |
| `invalid_input` | Bad range/sheet/rows, unreadable CSV or workbook, zip-bomb, row, cell or memory budget |
| `timeout` / `cancelled` | The parsing worker passed `EXCEL_CSV_TIMEOUT_MS` or the call was cancelled |
| `permission_denied` | A tool tried to turn CSV-injection protection off |
| `plugin_error` | Another failure |

## License
Apache-2.0
