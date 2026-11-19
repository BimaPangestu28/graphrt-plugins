# excel-csv operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `excel-csv.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_sheets` | Lists an .xlsx workbook's sheets with their 1-based index, visibility and used row/column counts | **input** |
| `read` | Reads rows from a CSV/TSV file or an XLSX sheet (optionally an A1 range). Formula cells give their saved results, dates ISO strings. Rows come as objects keyed by the header row, or as arrays | **input**, sheet, range, header_row, max_rows, delimiter, row_format |
| `write` | Writes rows (objects or arrays) to a new CSV or XLSX file in EXCEL_CSV_OUTPUT_DIR. XLSX cells are always literal values, never formulas; CSV cells that look like formulas are neutralised | **rows**, columns, format, sheet_name, delimiter, csv_injection_protection, output_name |
| `convert` | Converts a CSV/TSV file to XLSX (decimal text becomes numbers unless keep_text) or an XLSX sheet to CSV; writes a new file | **input**, **to**, sheet, sheet_name, delimiter, keep_text, csv_injection_protection, output_name |
