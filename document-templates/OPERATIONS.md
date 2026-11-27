# document-templates operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `document-templates.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_templates` | Lists the ready-made templates and the kinds of template you can bring yourself (your own layout, a PDF form, a Word document), with the operation for each |  |
| `describe_template` | Shows what a template needs before you fill it: for the invoice or your own layout, its fields with an example; for a Word document, its {{placeholders}}; for a PDF form, its boxes (or that it has none) | template, include_layout |
| `save_template_copy` | Saves your own copy of a ready-made template in your documents folder (in the folder Templates), so that you can change its texts, colours and layout while the original stays as it is. Nothing is ever replaced: when the name is taken, the copy gets a number. To use your copy, give its `path` as `template` when creating a PDF | template, name |
| `next_number` | Gives the next number of a series, such as INV-2026-0001, then INV-2026-0002, so that no two documents get the same number. The count starts again with each new year (or month, when the pattern has one). The last number is remembered in your documents folder | pattern, date, start_at, preview |
| `render_pdf` | Creates a PDF document, such as an invoice, from a template and your values: the ready-made `invoice`, or your own template. Totals are calculated for you and a long list of items continues on the next page. The PDF is saved in your documents folder, sorted by year and month (2026/11/INV-2026-0001.pdf), and a document that is already there is never replaced. The result says where the file is | template, values, values_file, calculate, background, folder, file_name, if_exists |
| `fill_pdf_form` | Fills in a PDF form (a PDF with boxes you can type in) and saves the result as a new PDF in your documents folder. `fields` says which value goes into which box; a value may use {{placeholders}} from `values`, including calculated totals such as {{totals.total \| money}}. A PDF without such boxes (a scan, a picture, plain pages) cannot be filled in: use render_pdf | **template**, fields, fields_file, values, values_file, calculate, flatten, folder, file_name, if_exists |
| `fill_docx` | Fills in a Word document that has {{placeholders}} (.docx, or a Word template .dotx) and saves the result as a new Word file in your documents folder. A table row between {{#items}} and {{/items}} repeats for every item, and totals are calculated for you. The result is a Word file, not a PDF | **template**, values, values_file, calculate, folder, file_name, if_exists |
