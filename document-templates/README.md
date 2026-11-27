# document-templates

**Status:** stable · **ToS risk:** none. Local only; its example workflow produced a real invoice PDF from real files during the build (PR #94). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin that makes **invoices and other documents from templates,
on your own computer**: no Google account, no browser, no office suite, no network. Workflows and agents give it
the values (who the invoice is for, the line items) and it:

- draws the document as a PDF from a **layout template**: the ready-made `invoice`, or your own,
- or fills a template you already have: a **fillable PDF form** or a **Word `.docx`** with placeholders,
- calculates the totals itself, in exact decimals,
- and files the result in a tidy folder, such as `2026/11/INV-2026-0042.pdf`, without ever replacing a document
  that is already there.

PDFs are drawn with [pdfmake](https://pdfmake.github.io/docs/) (pure JavaScript, on pdfkit and fontkit) and the
bundled Inter and EB Garamond fonts, so a document looks the same on Linux, Windows and macOS. PDF forms use
[pdf-lib](https://pdf-lib.js.org/), Word templates [docxtemplater](https://docxtemplater.com/).

## Which template formats work

| Your template | Works? | Operation | You get |
|---------------|--------|-----------|---------|
| Nothing yet | yes | `render_pdf` with the built-in `invoice` | PDF |
| Your own design, written as a layout template (`.json`) | yes | `render_pdf` | PDF |
| A letterhead or pre-printed page as a PDF | yes, as the `background` of a layout template | `render_pdf` | PDF |
| A PDF with form fields (AcroForm) | yes | `fill_pdf_form` | PDF |
| A Word `.docx` with `{{placeholders}}` | yes | `fill_docx` | DOCX |
| A PDF that is a finished document, a scan or a picture | **no** | | |
| Word to PDF | **no** | | |
| Excel `.xlsx` | **no** | | |
| HTML | **no** | | |
| XFA forms (Adobe LiveCycle) | **no** | | |

Why not:
- **A PDF without form fields** has nothing to fill, and its old texts are part of the page: new text can only be
  drawn on top of it. A PDF exported as one picture (many invoice generators do this) is the clearest case.
  Recreate the design as a layout template instead; the built-in `invoice` started that way. A page that is empty
  where the content goes (a letterhead) does work, as a `background`.
- **Word to PDF** needs Word or LibreOffice to lay out the pages. Neither is a library; this plugin starts no other
  program. Open the filled `.docx` and export it, or use a layout template.
- **Excel**: adding rows for line items means rewriting formulas, merged cells and print areas, which only a
  spreadsheet program does reliably, and there is no way to a PDF without one. The `excel-csv` plugin writes plain
  tables.
- **HTML** needs a browser engine (150 MB or more), and an HTML template can run scripts and load things from the
  network.
- **XFA** is a different, retired form technology that pdf-lib cannot fill. A PDF that has both keeps its AcroForm.
- **Right-to-left scripts** (Arabic, Hebrew) are not laid out correctly yet.

## Features
- **`list_templates`:** the built-in templates and the formats above. Needs no configuration.
- **`describe_template`:** what a template needs. For a layout template: its fields (with what is required), its
  placeholders and sample values; `include_layout: true` also returns the whole layout, to save as a `.json` and
  adapt. For a `.docx`: its placeholders and repeating sections. For a PDF: its form fields, or that it has none.
- **`render_pdf`:** a layout template plus `values` becomes a PDF. Tables continue over pages with their header
  repeated, a `bottom` block is pinned to the foot of the last page, pages are numbered, a `watermark` such as
  PAID is optional, and a `background` PDF (your letterhead) can lie under every page.
- **`fill_pdf_form`:** `fields` maps form field names to values. A value may use `{{placeholders}}` from `values`,
  so `{"Total": "{{totals.total | money}}"}` puts the calculated total in the form. `flatten` (default on) turns
  the fields into plain page content.
- **`fill_docx`:** the same placeholders in a Word file. A table row between `{{#items}}` and `{{/items}}`
  repeats for every item.
- **`next_number`:** running numbers such as `INV-2026-0001` from a pattern.

Full operation reference: [OPERATIONS.md](OPERATIONS.md). Template reference: [TEMPLATES.md](TEMPLATES.md).

## Prerequisites
- Node.js 22.13 or newer.
- `npm install` in this directory (`pdfmake` 0.3.15, `pdf-lib` 1.17.1, `@pdf-lib/fontkit` 1.1.1, `fontkit` 3.0.0,
  `docxtemplater` 3.71.1, `pizzip` 3.3.0). Without it calls return `setup_required`.

## Installation
```bash
cd document-templates && npm install && cd ..
graphrt plugin install ./document-templates
```

## Configuration
| Variable | Default | Meaning |
|----------|---------|---------|
| `DOCUMENT_TEMPLATES_OUTPUT_DIR` | (none) | Existing folder (absolute or `~/...`) where documents are saved. Without it only `list_templates` and `describe_template` work. Files in it can also be read. |
| `DOCUMENT_TEMPLATES_INPUT_DIRS` | (none) | Comma-separated folders that your own templates, logos, backgrounds and values files may be read from, subfolders included. Not needed for the built-in invoice without a logo. |
| `DOCUMENT_TEMPLATES_FONTS` | (none) | Comma-separated font files (`.ttf`, `.otf`, `.ttc`; at most 8) for scripts the built-in fonts lack, e.g. `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` |
| `DOCUMENT_TEMPLATES_MAX_INPUT_BYTES` | 20 MiB | Largest input file |
| `DOCUMENT_TEMPLATES_MAX_OUTPUT_BYTES` | 50 MiB | Largest document; nothing is saved above it |
| `DOCUMENT_TEMPLATES_MAX_PAGES` | `200` | Most pages of a rendered PDF |
| `DOCUMENT_TEMPLATES_TIMEOUT_MS` | `60000` | Per call (1000 to 160000); the worker process is killed when it passes |
| `DOCUMENT_TEMPLATES_MAX_MEMORY_MB` | `768` | Memory budget of the worker process: heap cap and resident-memory (RSS) watchdog |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

## Quick Start
```bash
mkdir -p ~/invoices
export DOCUMENT_TEMPLATES_OUTPUT_DIR=~/invoices
graphrt run document-templates/example.yaml --plugins .
# INV-2026-0001: Rp 19.869.000, 1 page(s) -> /home/me/invoices/2026/11/INV-2026-0001.pdf
```
Run it again and you get `INV-2026-0002.pdf` next to it.

## Usage

### An invoice
```yaml
- id: invoice
  type: document-templates.render_pdf
  template: invoice
  values:
    number: INV-2026-0042
    date: "2026-11-27"          # default: today
    due_date: "2026-12-11"
    currency: IDR               # default USD; IDR when language is id
    language: id                # labels, dates and numbers: en or id
    seller: { name: CV Kenanga Digital, address: ["Jalan Kenanga 12", "Bandung 40115"], logo: logo.png }
    client: { name: PT Maju Bersama, address: ["Jalan Merdeka 45", "Jakarta 10110"] }
    items:
      - { description: Desain antarmuka, quantity: 3, unit: hari, unit_price: 1500000 }
      - { description: Lisensi server, amount: 2400000 }
    discount: { percent: 5 }
    taxes: [{ name: PPN, rate: 11 }, { name: PPh 23, rate: -2 }]
    payment: { details: [{ label: Bank, value: Bank Contoh }, { label: No. rekening, value: "000 111 2222" }] }
    notes: ["Pembayaran paling lambat 14 hari setelah tanggal invoice."]
```
Only `number`, `seller.name`, `client.name` and `items` are required; `describe_template` lists every field.
`values` may also be JSON text, or `values_file` names a `.json` file. The result:
```json
{ "path": "/home/me/invoices/2026/11/INV-2026-0042.pdf", "relative_path": "2026/11/INV-2026-0042.pdf",
  "folder": "2026/11", "file_name": "INV-2026-0042.pdf", "size_bytes": 34120, "replaced_existing": false,
  "template": "invoice", "number": "INV-2026-0042", "page_count": 1,
  "totals": { "currency": "IDR", "subtotal": "6900000", "discount": "345000", "tax_total": "589950",
              "total": "7144950", "amount_paid": "0", "balance_due": "7144950",
              "total_text": "Rp 7.144.950", "balance_due_text": "Rp 7.144.950" } }
```

The same template makes a quotation, a receipt or a pro forma invoice: set `labels`, e.g.
`labels: { title: Quotation, total_due: Total }`.

### Amounts and totals
- Write amounts as plain numbers: `1500000` or `"1050.50"`. `"1.500.000"`, `"1,500"` and `"Rp 1500"` are refused
  with the name of the field, because guessing which separator means what gets invoices wrong.
- An item has `amount`, or `quantity` and `unit_price` (and optionally a `discount`). If it has all three and they
  disagree, the call is refused.
- The plugin calculates: line amounts, subtotal, `discount` (`{percent}` or an amount), each entry of `taxes` on
  the subtotal after discount (a negative `rate` is a withholding, such as PPh 23), `shipping` (added after tax),
  the total, and the balance after `amount_paid`. Every amount is rounded (half away from zero) to the currency's decimals
  (IDR and JPY 0, most others 2; `decimals` overrides). Prices are tax exclusive.
- `calculate: none` turns this off and uses your own `totals` as given.
- Money appears as `Rp 1.500.000` or `USD 1,050.00`. A currency whose symbol is shared (`$`, `¥`) shows its code
  unless you set `currency_style: symbol`.

### Folders and file names
`folder` and `file_name` are patterns. The defaults are `{YYYY}/{MM}` and `{number}`.

| Token | Value |
|-------|-------|
| `{YYYY}` `{MM}` `{DD}` | The document's `date`, else today |
| `{number}` | `values.number` |
| `{client}` | `values.client.name` |
| `{template}` | The template's name |
| `{time}` | The time of the call, `HHMMSS` |
| `{values.any.field}` | Any other value |

`folder: "Invoices/{client}/{YYYY}"` with `file_name: "{number} {client}"` gives
`Invoices/PT Maju Bersama/2026/INV-2026-0042 PT Maju Bersama.pdf`. Characters that cannot be in a file name
(`/ \ : * ? " < > |`) become `-`, so the number `001/INV/XI/2026` is filed as `001-INV-XI-2026.pdf`.

`if_exists` decides what happens when the file is already there: `error` (default: keep it and fail), `number`
(save `...-2.pdf`, `...-3.pdf`) or `overwrite` (workflow nodes only).

### Running numbers
`next_number` with `pattern: "INV-{YYYY}-{SEQ:4}"` returns `INV-2026-0001`, then `INV-2026-0002`. The count
belongs to the pattern with its date filled in, so it restarts each year here, or each month with `{MM}` in the
pattern. `{ROMAN}` is the month as a Roman numeral (`{SEQ:3}/INV/{ROMAN}/{YYYY}` gives `007/INV/XI/2026`).
`start_at: 38` starts a new counter at 38, to continue an existing series. `preview: true` shows the next number
without using it.

Counters are kept in `.document-templates/numbering.json` inside the output folder. A number is used up when it
is issued, even if the document is then never made; edit that file to give one back.

### A PDF form
```yaml
- id: form
  type: document-templates.fill_pdf_form
  template: invoice-form.pdf
  fields: { InvoiceNo: "{{number}}", Client: "{{client.name}}", Total: "{{totals.total | money}}", Paid: true }
  values: { number: INV-2026-0042, client: { name: PT Maju Bersama }, items: [{ description: Jasa, amount: 500000 }] }
```
`describe_template` lists the form's field names. Keep the field map in a `.json` file and pass `fields_file` to
reuse it. A form has as many rows as it was drawn with: for the third item use `{{items.2.description}}`.

### A Word template
Type the placeholders in Word: `{{client.name}}`, `{{date | date}}`, `{{totals.total | money}}`. For line items,
put `{{#items}}` in the first cell of a table row and `{{/items}}` in its last cell; the row repeats.
`{{#flags.has_taxes}}...{{/flags.has_taxes}}` shows a part only when there are taxes, `{{^notes}}...{{/notes}}`
only when there are no notes.

### Other scripts
The built-in fonts cover Latin (including Vietnamese), Cyrillic and Greek. For Chinese, Japanese, Korean, Thai
and others, point `DOCUMENT_TEMPLATES_FONTS` at a font file that has them; characters the built-in font lacks are
then drawn with it. A character that no font has is an error that names it, never an empty box on an invoice.

## Safety
- **Templates are data, not code.** A placeholder is a name, a comparison and filters; there is no arithmetic,
  no function call and no access to anything but the values. Layout templates are checked against a list of known
  properties: they cannot name a font file, a URL, an attachment or an SVG. pdfmake is told to refuse every local
  path and URL; fonts and images reach it as bytes. Word placeholders use the same parser, and raw-XML tags
  (`{{@x}}`) are refused.
- **Files:** inputs must be regular files inside `DOCUMENT_TEMPLATES_INPUT_DIRS` (or the output folder), checked
  after `realpath` on both sides with a separator-suffixed prefix; symlinks out, `../`, FIFOs, devices and files
  with several hard links are refused, and a file outside the allowlist gets the same `not_found` as a missing
  one. Images must be PNG or JPEG by content, backgrounds and forms PDFs by content, Word files plain `.docx`
  (no macros), checked for zip bombs before unpacking. `DOCUMENT_TEMPLATES_FONTS` is configuration, not an
  argument, so those files may be anywhere.
- **Outputs:** every part of a folder or file name is reduced to a plain name, so no value can add a folder level
  or leave the output folder. Folders are created one level at a time under the real output folder and
  re-checked, so a link planted inside it leads nowhere. A document is written to a private staging file and
  published with `link()`, which cannot replace a file. Overwriting replaces only a plain regular file with one
  link, atomically.
- **Isolation:** laying out pages and parsing PDFs, Word files, images and fonts runs in a short-lived child
  process that gets bytes over IPC. `DOCUMENT_TEMPLATES_MAX_MEMORY_MB` is enforced as the V8 heap cap and by an
  RSS watchdog; on timeout, cancel or the memory budget the child is killed with SIGKILL.
- **Caps:** input and output bytes, 2 MiB of values, 2000 line items, 100000 layout parts after loops are
  unrolled, 20 images, 2000 form fields, pages per document (`DOCUMENT_TEMPLATES_MAX_PAGES`).
- **Agents vs nodes:** all six operations are available as tools. They read only allowlisted files and add new
  files to the output folder (setting `DOCUMENT_TEMPLATES_OUTPUT_DIR` is the opt-in for writing).
  `if_exists: overwrite` is for workflow nodes only; a tool call that asks for it gets `permission_denied`.
  `next_number` uses up a number each time it is called without `preview`.

## Errors
| Kind | When |
|------|------|
| `setup_required` | npm packages not installed, `DOCUMENT_TEMPLATES_OUTPUT_DIR` unset or missing, `DOCUMENT_TEMPLATES_INPUT_DIRS` unset when a file is read, a font file unreadable |
| `not_found` | A template, image, background or values file is missing or outside the allowed folders |
| `invalid_input` | Required values missing, an amount that is not a plain number, a template with an unknown property or malformed placeholder, a PDF without form fields, an unknown form field, a character no font has, a file that already exists, over a cap |
| `permission_denied` | A tool call asked for `if_exists: overwrite` |
| `timeout` / `cancelled` | The worker passed `DOCUMENT_TEMPLATES_TIMEOUT_MS` or the call was cancelled; nothing is saved |
| `plugin_error` | The worker crashed, the document could not be written, or the numbering file is locked |

## Fonts
[Inter](https://rsms.me/inter/) and [EB Garamond](https://github.com/octaviopardo/EBGaramond12) ship in `fonts/`
under the SIL Open Font License 1.1; the licence texts are next to them.

## License
Apache-2.0
