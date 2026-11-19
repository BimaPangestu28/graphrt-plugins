# pdf-tools operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `pdf-tools.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `info` | Page count, whether the PDF is encrypted, document metadata (title, author, subject, keywords, creator, producer, dates) and the size and rotation of up to 100 pages | **input** |
| `extract_text` | Extracts the text layer per page (no OCR: scanned pages come back empty; use ocr-tesseract for those), capped at max_chars | **input**, pages, max_chars |
| `merge` | Joins 2-50 PDFs in the given order into one new PDF | **inputs**, output_name |
| `extract_pages` | Copies the selected pages (in the order given, e.g. "3,1-2") into one new PDF | **input**, **pages**, output_name |
| `split` | Splits a PDF into several new PDFs: one per entry of `ranges` (e.g. ["1-2", "3-"]), or every N pages (default 1: one file per page); at most 200 files | **input**, ranges, every, output_name |
| `rotate` | Rotates the selected pages (default all) clockwise by 90, 180 or 270 degrees and writes a new PDF | **input**, degrees, pages, output_name |
| `watermark` | Draws a text watermark (Helvetica, Latin-1 characters) on the selected pages: centred, top or bottom, rotated, with colour and opacity | **input**, **text**, font_size, opacity, angle, color, placement, pages, output_name |
| `images_to_pdf` | Builds a PDF with one jpeg or png image per page: pages sized to each image (fit), or A4/Letter with the image scaled down to fit and centred | **images**, page_size, margin, output_name |
