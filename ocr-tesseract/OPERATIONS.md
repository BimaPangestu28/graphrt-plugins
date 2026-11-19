# ocr-tesseract operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `ocr-tesseract.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_languages` | Lists the Tesseract language packs installed on this machine (codes such as eng, ind, chi_sim) for the `languages` parameter of ocr |  |
| `ocr` | Reads text from an image (png, jpeg, tiff, bmp, gif, webp) or one page of a PDF with Tesseract, as plain text, hOCR (HTML with word boxes) or TSV (word, box, confidence); optionally saves it to OCR_TESSERACT_OUTPUT_DIR | **input**, languages, psm, output_format, page, dpi, max_chars, save_output, output_name |
