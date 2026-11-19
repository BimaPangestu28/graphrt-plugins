# ocr-tesseract

**Status:** stable · **ToS risk:** none. Local only; its example workflow ran on real files during the build (PR #40). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **OCR with the system
[Tesseract](https://github.com/tesseract-ocr/tesseract)**. Workflows and agents can read text from scanned images,
photos of documents and PDF pages that live in directories you allow, as plain text, hOCR or TSV.

## Features
- **`list_languages`:** the installed language packs (e.g. `eng`, `ind`, `chi_sim`) and the tessdata directory.
- **`ocr`:** an image (png, jpeg, tiff, bmp, gif, webp) or one `page` of a PDF (rendered at `dpi` with poppler's
  `pdftoppm`), with `languages` (1–5 installed codes), `psm` (page segmentation mode 0–13) and `output_format`:
  `text`, `hocr` (HTML with word boxes) or `tsv` (one row per word with box and confidence). `max_chars` caps the
  returned text (`truncated` says so); `save_output: true` also writes it to a new file in
  `OCR_TESSERACT_OUTPUT_DIR`.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer.
- `tesseract` on `PATH` (`brew install tesseract tesseract-lang`, `apt install tesseract-ocr tesseract-ocr-ind`), or
  `TESSERACT_BINARY`. Without it every call returns `setup_required`.
- For PDF pages only: `pdftoppm` from poppler (`brew install poppler`, `apt install poppler-utils`), or
  `PDFTOPPM_BINARY`. A missing or broken poppler (e.g. a missing shared library) gives `setup_required` for PDFs;
  images still work.

## Installation
```bash
graphrt plugin install ./ocr-tesseract
```
There is nothing to `npm install`.

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `OCR_TESSERACT_INPUT_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that images and PDFs may be read from, subdirectories included |
| `OCR_TESSERACT_OUTPUT_DIR` | (none) | Existing directory for `save_output`; reading text needs no output directory |
| `OCR_TESSERACT_MAX_INPUT_BYTES` | 50 MiB | Largest input file |
| `OCR_TESSERACT_MAX_OUTPUT_BYTES` | 50 MiB | Largest saved result |
| `OCR_TESSERACT_TIMEOUT_MS` | `120000` | Per tesseract/pdftoppm run (1000 to 280000); the process is killed when it passes |
| `OCR_TESSERACT_MAX_INPUT_PIXELS` | `40000000` | Most pixels (width × height) of an image, or of a PDF page rendered at `dpi` |
| `TESSERACT_BINARY`, `PDFTOPPM_BINARY` | on `PATH` | Absolute paths to the programs |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

## Quick Start
```bash
mkdir -p ~/scans   # put scan.png in ~/scans
export OCR_TESSERACT_INPUT_DIRS=~/scans
graphrt run ocr-tesseract/example.yaml --plugins .
```

## Usage
```json
{ "path": "/Users/me/scans/scan.png", "input_kind": "image", "page": null, "languages": ["eng"], "psm": 3, "format": "text", "text": "Halo Dunia 2026\n", "truncated": false }
```
Common `psm` values: 3 automatic (default), 4 one column, 6 one uniform block, 7 one line, 11 sparse text.

## Safety
- **Files:** inputs must be regular files inside `OCR_TESSERACT_INPUT_DIRS` (or the output directory), checked after
  `realpath` on both sides with a separator-suffixed prefix; symlinks out, `../`, FIFOs and devices are refused, and
  a file outside the allowlist gets the same `not_found` as a missing one.
- **Content, not names:** an input must be a raster image or a PDF by its first bytes. This matters because
  Tesseract reads a *text* input as a list of other image paths to open; such files (and SVGs) are refused.
- **No shell:** tesseract and pdftoppm get argument arrays. Languages must match `[A-Za-z0-9_]` and be in the
  installed list, and `psm`, `page` and `dpi` are bounded integers, so no option can be injected. No custom
  Tesseract configs or `-c` variables are exposed.
- **Decoded size:** an image's header dimensions are read before tesseract sees it and refused over
  `OCR_TESSERACT_MAX_INPUT_PIXELS`. For PDFs the largest `/MediaBox` × `dpi` must fit the same cap (lower `dpi`
  otherwise), and pdftoppm is always told to crop its render to that size (`-W`/`-H`), so memory stays bounded even
  when page sizes sit in compressed object streams the check can't read (then the crop is a square of the cap's
  area).
- **PDF pages** are rendered into a private temp directory that is removed after the call.
- **Hard links:** inputs with more than one hard link are refused, since a hard link inside an allowed directory
  could point at a file outside it.
- **Error messages** keep the program's reason but replace paths outside the allowed directories (library
  locations, temp files) with `[path]`.
- **Limits:** a timeout per run with SIGKILL, cancel kills the program at once, 8 MiB of OCR output per run,
  `max_chars` of returned text, two calls at a time.
- **Agents vs nodes:** both operations are tools. `save_output` only adds new files with generated names to the
  output directory (setting `OCR_TESSERACT_OUTPUT_DIR` is the opt-in), created exclusively, never overwriting.

## Errors
| Kind | When |
|------|------|
| `setup_required` | tesseract (or, for PDFs, pdftoppm) missing or unable to start, language data missing, input directories unset |
| `not_found` | The file is missing or outside the allowed directories |
| `invalid_input` | Not an image or PDF, over the pixel cap, language not installed, page outside the PDF, bad arguments |
| `timeout` / `cancelled` | A run passed `OCR_TESSERACT_TIMEOUT_MS` or the call was cancelled |
| `plugin_error` | tesseract or pdftoppm failed for another reason (its last message is included) |

## License
Apache-2.0
