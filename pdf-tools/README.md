# pdf-tools

**Status:** stable · **ToS risk:** none. Local only; its example workflow ran on real files during the build (PR #40). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **local PDF files**. Workflows and agents can read a
PDF's page count, metadata and text, and build new PDFs by merging, extracting, splitting, rotating, watermarking, or
from images. It uses [pdf-lib](https://pdf-lib.js.org/) for structure and Mozilla's
[pdfjs-dist](https://github.com/mozilla/pdf.js) (legacy build) for text. Every result is a new file in one output
directory.

## Features
- **`info`:** page count, `encrypted`, title, author, subject, keywords, creator, producer, creation and modification
  dates, and the size and rotation of up to 100 pages.
- **`extract_text`:** the text layer per page for `pages` (e.g. `"1-3,5,8-"`), capped by `max_chars` (default
  100000) with a `truncated` flag. There is no OCR: scanned pages come back empty (use the ocr-tesseract plugin).
- **`merge`:** 2–50 PDFs in order.
- **`extract_pages`:** the selected pages, in the order given (`"3,1-2"`), into one PDF.
- **`split`:** one PDF per entry of `ranges` (`["1-2", "3-"]`), or every `every` pages (default one file per page);
  at most 200 files.
- **`rotate`:** 90, 180 or 270 degrees clockwise, added to each selected page's rotation.
- **`watermark`:** a Helvetica text line (Latin-1 characters) with `font_size`, `opacity`, `angle`, `color` and
  `placement` (`center`, `top`, `bottom`) on the selected pages.
- **`images_to_pdf`:** jpeg/png images, one per page, at their own size (`fit`) or scaled into A4/Letter with a
  `margin`.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 22.13 or newer (pdfjs-dist 6 needs it).
- `npm install` in this directory (`pdf-lib` 1.17.1, `pdfjs-dist` 6.4.299). Without it calls return
  `setup_required`.

## Installation
```bash
cd pdf-tools && npm install && cd ..
graphrt plugin install ./pdf-tools
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `PDF_TOOLS_INPUT_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that files may be read from, subdirectories included |
| `PDF_TOOLS_OUTPUT_DIR` | (none) | Existing directory for outputs. Without it only `info` and `extract_text` work. Outputs can be read back as inputs. |
| `PDF_TOOLS_MAX_INPUT_BYTES` | 100 MiB | Largest input file |
| `PDF_TOOLS_MAX_OUTPUT_BYTES` | 200 MiB | Largest output; nothing is written above it |
| `PDF_TOOLS_MAX_PAGES` | `2000` | Most pages per input, and per merged output |
| `PDF_TOOLS_TIMEOUT_MS` | `120000` | Per call (1000 to 280000); the worker process is killed when it passes |
| `PDF_TOOLS_MAX_MEMORY_MB` | `1024` | Memory budget of the worker process: heap cap and resident-memory (RSS) watchdog |
| `PDF_TOOLS_MAX_TOTAL_INPUT_BYTES` | 200 MiB | Most bytes read in one call across all inputs (`merge`, `images_to_pdf`) |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

## Quick Start
```bash
mkdir -p ~/pdfs/in ~/pdfs/out   # put report.pdf in ~/pdfs/in
export PDF_TOOLS_INPUT_DIRS=~/pdfs/in PDF_TOOLS_OUTPUT_DIR=~/pdfs/out
graphrt run pdf-tools/example.yaml --plugins .
```

## Usage
Paths may be absolute, `~/...`, or relative to the first input directory. An output looks like:
```json
{ "path": "/Users/me/pdfs/out/merged-20261119-080102-1a2b3c4d.pdf", "file_name": "merged-20261119-080102-1a2b3c4d.pdf", "size_bytes": 48211, "page_count": 5 }
```
`output_name` sets the start of the generated name; a UTC timestamp and random suffix are always added.

## Safety
- **Files:** inputs must be regular files inside `PDF_TOOLS_INPUT_DIRS` (or the output directory), checked after
  `realpath` on both sides with a separator-suffixed prefix; symlinks out, `../`, FIFOs and devices are refused, and
  a file outside the allowlist gets the same `not_found` as a missing one. PDFs must have a `%PDF-` header; images
  for `images_to_pdf` must be jpeg or png by content.
- **Isolation:** all parsing runs in a short-lived child process that gets the bytes over IPC and never touches the
  file system. `PDF_TOOLS_MAX_MEMORY_MB` is enforced twice: as the V8 heap cap, and by an RSS watchdog that polls the
  child's resident memory every 50 ms and kills it past the budget. (On Windows a reading takes a `tasklist` run, so it happens a few times a second.) The heap cap alone is not enough: decompressed
  streams live in typed arrays outside the heap, and a 600 KB Flate bomb can otherwise reach well over 1 GB. On
  timeout, cancel or the memory budget the child is killed with SIGKILL, so a hostile PDF can't hang or bloat the
  plugin. Between two polls a very fast allocation can overshoot the budget briefly. pdfjs runs with `isEvalSupported: false`, no font
  loading and no XFA; its console output goes to the child's ignored stdout, never the protocol.
- **Caps:** input/output bytes, total input bytes per call, pages per document (`PDF_TOOLS_MAX_PAGES`), 50 merge inputs, 200 split outputs,
  200 images, `max_chars` of text.
- **Outputs:** always new files with generated names, created exclusively (`wx`), never overwriting anything. A
  `split` that fails partway removes the parts it already wrote and names them in the error.
- **Hard links:** inputs with more than one hard link are refused, since a hard link inside an allowed directory
  could point at a file outside it.
- **Encrypted PDFs** are reported by `info` and refused by the other operations.
- **Agents vs nodes:** all operations are available as tools; they only read allowlisted files and add new files to
  the output directory (setting `PDF_TOOLS_OUTPUT_DIR` is the opt-in for writing).

## Errors
| Kind | When |
|------|------|
| `setup_required` | npm packages not installed, `PDF_TOOLS_INPUT_DIRS` or (for outputs) `PDF_TOOLS_OUTPUT_DIR` unset |
| `not_found` | The file is missing or outside the allowed directories |
| `invalid_input` | Not a PDF, unreadable or encrypted PDF, over a cap (including the memory budget), bad page selection, text the font can't draw |
| `timeout` / `cancelled` | The worker passed `PDF_TOOLS_TIMEOUT_MS` or the call was cancelled; nothing is kept |
| `plugin_error` | The worker crashed (malformed file or memory limit) or another failure |

## License
Apache-2.0
