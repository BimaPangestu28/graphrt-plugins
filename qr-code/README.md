# qr-code

**Status:** stable · **ToS risk:** none. Local only; the example wrote a PNG that decoded back to its URL (PR #40). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **QR codes**. Workflows and agents can generate a QR
code as a new PNG or SVG file, and decode the QR codes in a local image. Generation uses
[qrcode](https://github.com/soldair/node-qrcode); decoding uses [zxing-wasm](https://github.com/Sec-ant/zxing-wasm)
(the ZXing C++ reader compiled to WebAssembly), both pure JavaScript/WebAssembly with no native build.

## Features
- **`generate`:** `text` (a URL or any text) as `png` or `svg`, with `error_correction` (L, M, Q, H), `margin`,
  `module_size` or `image_size`, `dark_color` and `light_color`; `include_data: true` also returns the SVG text or a
  PNG `data:` URL.
- **`decode`:** QR, Micro QR and rMQR codes in a png, jpeg, gif or bmp image: each code's text, content type, error
  correction level and corner positions, up to `max_codes`; `try_harder` also tries rotated and inverted images.

Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer.
- `npm install` in this directory (`qrcode` 1.5.4, `zxing-wasm` 3.1.6). Without it calls return `setup_required`.

## Installation
```bash
cd qr-code && npm install && cd ..
graphrt plugin install ./qr-code
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `QR_CODE_INPUT_DIRS` | (required for `decode`) | Comma-separated directories (absolute or `~/...`) that images may be read from, subdirectories included |
| `QR_CODE_OUTPUT_DIR` | (required for `generate`) | Existing directory for generated codes; they can be read back by `decode` |
| `QR_CODE_MAX_INPUT_BYTES` | 25 MiB | Largest image to decode |
| `QR_CODE_MAX_OUTPUT_BYTES` | 10 MiB | Largest generated file |
| `QR_CODE_MAX_INPUT_PIXELS` | `40000000` | Most pixels (width × height, read from the header) of an image to decode |
| `QR_CODE_MAX_OUTPUT_PIXELS` | `16777216` (4096²) | Most pixels of a generated PNG ((modules + 2 × margin) × module_size, squared) |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

## Quick Start
```bash
mkdir -p ~/qr/out
export QR_CODE_OUTPUT_DIR=~/qr/out
graphrt run qr-code/example.yaml --plugins .
```

## Usage
```json
{ "path": "/Users/me/qr/out/qr-20261119-080102-1a2b3c4d.png", "file_name": "qr-20261119-080102-1a2b3c4d.png", "size_bytes": 1043, "format": "png" }
```
`decode` returns `{ "count": 1, "codes": [{ "text": "https://example.com", "format": "QRCode", "error_correction_level": "M", "position": { "topLeft": { "x": 32, "y": 32 }, ... } }] }`.

## Safety
- **No network:** zxing-wasm downloads its `.wasm` from a CDN by default; this plugin always passes the copy inside
  `node_modules` instead, so decoding works offline and never fetches anything (tested).
- **Files:** images must be regular files inside `QR_CODE_INPUT_DIRS` (or the output directory), checked after
  `realpath` on both sides with a separator-suffixed prefix; symlinks out, `../`, FIFOs and devices are refused, and
  a file outside the allowlist gets the same `not_found` as a missing one.
- **Content and size:** an image must be png, jpeg, gif or bmp by its first bytes, and its header's width × height
  must be within `QR_CODE_MAX_INPUT_PIXELS` before the decoder allocates anything.
- **Outputs:** always new files with generated names, created exclusively (`wx`), never overwriting anything. Colours
  must be hex values, so nothing else reaches the SVG. A PNG's size is computed from the QR version before rendering
  and refused over `QR_CODE_MAX_OUTPUT_PIXELS` (a long text at `module_size` 50 would otherwise be over 100 megapixels).
- **Hard links:** images with more than one hard link are refused, since a hard link inside an allowed directory
  could point at a file outside it.
- **Agents vs nodes:** both operations are tools; `generate` only adds new files to the output directory (setting
  `QR_CODE_OUTPUT_DIR` is the opt-in for writing). Decoded text is returned as data and never acted on.

## Errors
| Kind | When |
|------|------|
| `setup_required` | npm packages not installed, or the needed directory variable unset |
| `not_found` | The image is missing or outside the allowed directories |
| `invalid_input` | Text too long for the error correction level, bad colour, not a supported image, over the pixel cap |
| `plugin_error` | Another failure |

## License
Apache-2.0
