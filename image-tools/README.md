# image-tools

**Status:** stable · **ToS risk:** none. Local only; its example workflow ran on real files during the build (PR #40). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/BimaPangestu28/graphrt) plugin for **local images** with
[sharp](https://sharp.pixelplumbing.com/) (libvips). Workflows and agents can read image metadata and resize, crop,
rotate, convert, compress, watermark and thumbnail images that live in directories you allow. Every result is a new
file in one output directory.

## Features
- **`metadata`:** format (detected from the content), displayed width/height after EXIF orientation, orientation,
  channels, colour space, alpha, density, pages, and whether EXIF/ICC/XMP data is present.
- **`resize`:** `target_width` and/or `target_height`, `fit` (`inside`, `cover`, `contain`, `fill`, `outside`), no enlarging unless
  `enlarge: true`, padding `background` for `contain`.
- **`crop`:** `left`, `top`, `crop_width`, `crop_height` on the displayed image; a box outside the image is refused.
- **`rotate`:** any angle (corners filled with `background`), plus `flip`/`flop`.
- **`convert`:** jpeg, png, webp, avif, gif or tiff with optional `quality`.
- **`compress`:** re-encodes at `quality` (default 75), optionally capping the longest side, and reports the bytes saved.
- **`watermark`:** a text line (`text`, `font_size`, `color`) or a second image (`image`, `image_scale`) at one of nine
  positions (`placement`) with `margin` and `opacity`.
- **`thumbnails`:** up to 10 widths in one call (default webp, never enlarged).

All transforms auto-orient from EXIF first and write outputs **without** the input's metadata (EXIF, GPS). Animated
inputs use their first frame. Full operation reference: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20.9 or newer.
- `npm install` in this directory (installs `sharp` 0.35.5 with its prebuilt libvips). Without it every call
  returns `setup_required`.

## Installation
```bash
cd image-tools && npm install && cd ..
graphrt plugin install ./image-tools
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `IMAGE_TOOLS_INPUT_DIRS` | (required) | Comma-separated directories (absolute or `~/...`) that images may be read from, subdirectories included |
| `IMAGE_TOOLS_OUTPUT_DIR` | (none) | Existing directory for outputs. Without it only `metadata` works. Outputs can be read back as inputs. |
| `IMAGE_TOOLS_MAX_INPUT_BYTES` | 100 MiB | Largest input file |
| `IMAGE_TOOLS_MAX_OUTPUT_BYTES` | 100 MiB | Largest output; nothing is written above it |
| `IMAGE_TOOLS_MAX_INPUT_PIXELS` | `100000000` | Most decoded pixels (width × height) per image, against decompression bombs |
| `IMAGE_TOOLS_TIMEOUT_SECONDS` | `60` | libvips timeout per pipeline (1 to 600) |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

## Quick Start
```bash
mkdir -p ~/images/in ~/images/out   # put photo.jpg in ~/images/in
export IMAGE_TOOLS_INPUT_DIRS=~/images/in IMAGE_TOOLS_OUTPUT_DIR=~/images/out
graphrt run image-tools/example.yaml --plugins .
```

## Usage
Paths may be absolute, `~/...`, or relative to the first input directory. A result looks like:
```json
{ "path": "/Users/me/images/out/photo-20261119-080102-1a2b3c4d.webp", "file_name": "photo-20261119-080102-1a2b3c4d.webp", "size_bytes": 18211, "format": "webp", "width": 640, "height": 427 }
```
`output_name` sets the start of the generated name; a UTC timestamp and random suffix are always added.

## Safety
- **Files:** inputs must be regular files inside `IMAGE_TOOLS_INPUT_DIRS` (or the output directory), checked after
  `realpath` on both sides with a separator-suffixed prefix; symlinks out, `../`, FIFOs and devices are refused, and
  a file outside the allowlist gets the same `not_found` as a missing one. Files are opened with `O_NOFOLLOW` and
  re-checked after opening.
- **Content, not names:** an input must *be* a jpeg, png, webp, gif, tiff, avif or heif image by its first bytes.
  SVG (which can reference other files), PDF and anything else is refused even when renamed `.png`.
- **Decompression bombs:** the header's width × height is checked against `IMAGE_TOOLS_MAX_INPUT_PIXELS` before
  decoding, and sharp's own `limitInputPixels` enforces it again; corrupt images fail (`failOn: "error"`).
- **Outputs:** always new files with generated names, created exclusively (`wx`), never overwriting anything; over
  the size cap nothing is written. `thumbnails` is all or nothing: if one cannot be written, the ones already
  written are removed and named in the error.
- **Hard links:** inputs with more than one hard link are refused, since a hard link inside an allowed directory
  could point at a file outside it.
- **Watermark text** goes into an SVG the plugin builds itself (XML-escaped, colours validated as hex), so text can't
  add elements or references.
- **Agents vs nodes:** all operations are available as tools; they only read allowlisted files and add new files to
  the output directory (setting `IMAGE_TOOLS_OUTPUT_DIR` is the opt-in for writing).
- **Limits:** a libvips timeout per pipeline. sharp can't be interrupted midway, so a cancel is honoured before and
  after the encode step.

## Errors
| Kind | When |
|------|------|
| `setup_required` | sharp not installed, `IMAGE_TOOLS_INPUT_DIRS` or (for outputs) `IMAGE_TOOLS_OUTPUT_DIR` unset |
| `not_found` | The file is missing or outside the allowed directories |
| `invalid_input` | Bad arguments, not a supported raster image, over the pixel or size cap, crop box outside the image |
| `timeout` / `cancelled` | The pipeline passed its timeout or the call was cancelled; nothing is kept |
| `plugin_error` | sharp failed for another reason |

## License
Apache-2.0
