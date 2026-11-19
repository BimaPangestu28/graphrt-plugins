# qr-code operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `qr-code.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `generate` | Encodes text or a URL as a QR code and writes it as a new PNG or SVG file in QR_CODE_OUTPUT_DIR (error correction, margin, size and colours adjustable) | **text**, format, error_correction, module_size, image_size, margin, dark_color, light_color, include_data, output_name |
| `decode` | Finds and decodes QR codes (also Micro QR and rMQR) in a png, jpeg, gif or bmp image, returning each code's text, error correction level and corner positions | **input**, max_codes, try_harder |
