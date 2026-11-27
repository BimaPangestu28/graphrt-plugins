# document-templates operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `document-templates.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_templates` | Lists the built-in templates and the template formats this plugin can fill, with the operation for each |  |
| `describe_template` | Shows what a template needs: for a layout template its fields, placeholders and sample values; for a Word template its {{placeholders}}; for a PDF its form fields (or that it has none) | template, include_layout |
| `next_number` | Issues the next running number for a pattern such as INV-{YYYY}-{SEQ:4} (INV-2026-0001, INV-2026-0002, ...). The count restarts when the pattern's date part changes. Counters are kept in DOCUMENT_TEMPLATES_OUTPUT_DIR/.document-templates/numbering.json | pattern, date, start_at, preview |
| `render_pdf` | Creates a PDF from a layout template and values: the built-in `invoice`, or your own .json layout template. Totals are calculated for you, the table continues over pages, and the PDF is saved as <folder>/<file_name>.pdf (default 2026/11/INV-2026-0001.pdf). An existing file is never replaced unless a node asks | template, values, values_file, calculate, background, folder, file_name, if_exists |
| `fill_pdf_form` | Fills the form fields of a fillable PDF (AcroForm) and saves the result as a new PDF. `fields` maps field names to values; a value may use {{placeholders}} from `values`, including calculated totals such as {{totals.total \| money}}. A PDF without form fields (a scan, a picture, plain pages) cannot be filled: use render_pdf | **template**, fields, fields_file, values, values_file, calculate, flatten, folder, file_name, if_exists |
| `fill_docx` | Fills the {{placeholders}} of a Word .docx template and saves the result as a new .docx. A table row between {{#items}} and {{/items}} repeats for every item, and totals are calculated for you. The result is a Word file, not a PDF | **template**, values, values_file, calculate, folder, file_name, if_exists |
