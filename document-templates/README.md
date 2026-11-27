# document-templates

**Status:** stable · **ToS risk:** none. Local only; its example workflow produced a real invoice PDF from real files during the build (PR #94). See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin that makes **invoices and other documents from templates,
on your own computer**: no Google account, no browser, no office suite, no network. Workflows and agents give it
the values (who the invoice is for, the line items) and it:

- draws the document as a PDF from a **layout template**: the ready-made `invoice`, or your own,
- or fills a template you already have: a **fillable PDF form** or a **Word `.docx`** with placeholders,
- calculates the totals itself, in exact decimals,
- gives the invoice **your look without editing anything**: a logo, an accent colour, the title, English or
  Indonesian, and which columns and blocks show, said once and remembered,
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
| A Word `.docx` or `.dotx` (Word template) with `{{placeholders}}` | yes | `fill_docx` | DOCX |
| A PDF form that is protected (encrypted), as many official forms are | yes; with its password when it asks for one | `fill_pdf_form` | PDF, without the protection |
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
- **XFA** is a different, retired form technology (Adobe LiveCycle Designer) that pdf-lib cannot fill. Most
  official forms carry both kinds: those are filled through their standard fields, and the XFA copy is removed
  so that no viewer shows it empty. A PDF that is XFA only (other programs show "Please wait...") is refused.
- **Right-to-left scripts** (Arabic, Hebrew) are not laid out correctly yet.

## Protected PDF forms
Many official forms are protected (encrypted). There are two kinds, and both work:

- **Forms that open without a password** and are protected only so that the page cannot be changed or copied
  (USCIS, OPM and many other agencies publish forms this way). They are filled in like any other form; you give
  no password.
- **Forms that ask for a password when you open them.** Give that password as `password` to `describe_template`
  and `fill_pdf_form`. It is used once, in memory, to open the file. It is never saved, never written to a log
  and never part of a result or an error message. A password is never guessed: without the right one the form
  is refused, with a message that says a password is needed or that the one given does not fit.

What you get: **the filled-in PDF is saved without the protection.** It opens in every PDF program without a
password, and other steps (merging, e-mailing, printing) can read it. If the document should stay behind a
password, protect the result again with your PDF program. The result says `was_protected: true` when this
happened.

**When the publisher forbids filling in.** A protected PDF carries the publisher's permissions: printing,
copying, changing, filling in. A form whose permissions forbid filling it in (neither "fill in form fields" nor
"comment and fill in" is allowed) is **not filled in**: `describe_template` still lists its boxes, with
`filling_allowed: false`, and `fill_pdf_form` refuses with a message that says so. Give the form's permissions
password (also called the owner password) as `password` and it is filled in, because that password is the
publisher's own way to lift the restrictions. Other restrictions (no printing, no copying, no changing the
pages) do not stop filling in, as in Adobe Reader. None of the official forms tested forbids it.

All protection formats of the PDF standard's password security are opened (RC4 40 and 128 bit, AES 128 and 256
bit), by [qpdf](https://qpdf.org) compiled to WebAssembly: nothing to install, the same on Windows, macOS and
Linux, and it runs inside the worker process without touching a file on disk. PDFs protected with a
certificate instead of a password are refused.

## Features
- **`list_templates`:** the built-in templates and the formats above. Needs no configuration.
- **`describe_template`:** what a template needs. For a layout template: its fields (with what is required), its
  placeholders and sample values; `include_layout: true` also returns the whole layout, to save as a `.json` and
  adapt. For a `.docx`: its placeholders and repeating sections. For a PDF: its form fields, or that it has none;
  for a protected PDF also whether its publisher allows filling it in.
- **`render_pdf`:** a layout template plus `values` becomes a PDF. Tables continue over pages with their header
  repeated, a `bottom` block is pinned to the foot of the last page, pages are numbered, a `watermark` such as
  PAID is optional, and a `background` PDF (your letterhead) can lie under every page. With `number_pattern` it
  gives the document the next running number itself, and only once the PDF is saved
  ([Running numbers](#running-numbers)).
- **`check_values`:** checks an invoice before it is made, with every check `render_pdf` runs, and says what is
  wrong in plain words. It saves nothing and uses no number, so it can run before anyone approves.
- **`fill_pdf_form`:** `fields` maps form field names to values. A value may use `{{placeholders}}` from `values`,
  so `{"Total": "{{totals.total | money}}"}` puts the calculated total in the form. `flatten` (default on) turns
  the fields into plain page content. Protected forms are filled in too, with `password` when the form asks
  for one ([Protected PDF forms](#protected-pdf-forms)).
- **`fill_docx`:** the same placeholders in a Word file. A table row between `{{#items}}` and `{{/items}}`
  repeats for every item.
- **`save_template_copy`:** saves your own copy of the built-in invoice in the folder `Templates` of your
  documents folder, to change its texts, colours and layout. It never replaces a file; ask for it in chat, no
  terminal needed.
- **`next_number`:** running numbers such as `INV-2026-0001` from a pattern, for documents that are not made by
  `render_pdf` (a Word file, a PDF form).
- **`save_brand` and `show_brand`:** the look of your documents and your own details, saved once and used for
  every later invoice; your details also fill Word templates and PDF forms
  ([Your logo, colour and wording](#your-logo-colour-and-wording), [Your details in Word and PDF forms](#your-details-in-word-and-pdf-forms)).
- **Ready-made agents:** "Make an invoice" and "Buat invoice", finished workflows that need no AI model
  ([Ready-made agents](#ready-made-agents)).

Full operation reference: [OPERATIONS.md](OPERATIONS.md). Template reference: [TEMPLATES.md](TEMPLATES.md).

## Prerequisites
- Node.js 22.13 or newer.
- `npm install` in this directory (`pdfmake` 0.3.15, `pdf-lib` 1.17.1, `@pdf-lib/fontkit` 1.1.1, `fontkit` 3.0.0,
  `docxtemplater` 3.71.1, `pizzip` 3.3.0, `@neslinesli93/qpdf-wasm` 0.3.1, which is qpdf 12.2.0). Without it calls return `setup_required`.

## Installation
```bash
cd document-templates && npm install && cd ..
graphrt plugin install ./document-templates
```

## Configuration
Only the first setting has to be filled in: the folder your documents go to. Every other one has a default
that suits most people and can stay empty.

| Variable | Default | Meaning |
|----------|---------|---------|
| `DOCUMENT_TEMPLATES_OUTPUT_DIR` | (none) | **Needed.** Your documents folder: an existing folder (absolute or `~/...`) where documents are saved. Without it only `list_templates` and `describe_template` work. Files in it can also be read. |
| `DOCUMENT_TEMPLATES_INPUT_DIRS` | (none) | Comma-separated folders that your own templates, logos, backgrounds and values files may be read from, subfolders included. Not needed for the built-in invoice without a logo. |
| `DOCUMENT_TEMPLATES_FONTS` | (none) | Comma-separated font files (`.ttf`, `.otf`, `.ttc`; at most 8) for scripts the built-in fonts lack, e.g. `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` |
| `DOCUMENT_TEMPLATES_MAX_INPUT_BYTES` | 20 MiB | Largest input file |
| `DOCUMENT_TEMPLATES_MAX_OUTPUT_BYTES` | 50 MiB | Largest document; nothing is saved above it |
| `DOCUMENT_TEMPLATES_MAX_PAGES` | `200` | Most pages of a rendered PDF |
| `DOCUMENT_TEMPLATES_MAX_FORM_FIELDS` | `10000` | Most fields of a PDF form (1 to 100000). The largest official form tested, OPM SF 86 with 6197 fields on 136 pages, is filled in about 7 seconds with 420 MB |
| `DOCUMENT_TEMPLATES_TIMEOUT_MS` | `60000` | Per call (1000 to 160000); the worker process is killed when it passes |
| `DOCUMENT_TEMPLATES_MAX_MEMORY_MB` | `768` | Memory budget of the worker process: heap cap and resident-memory (RSS) watchdog |

The plugin is local only: it asks graphrt for no network access and no secrets, and nodes have no `access_token`.

[`graphrt-settings.json`](graphrt-settings.json) tells graphrt Desktop what to call these settings, which one is
needed (the documents folder) and what the defaults are, so the app shows a folder picker and plain labels
instead of the variable names.

## Quick Start
```bash
mkdir -p ~/invoices
export DOCUMENT_TEMPLATES_OUTPUT_DIR=~/invoices
graphrt run document-templates/example.yaml --plugins .
# INV-2026-0001: Rp 19.869.000, 1 page(s) -> /home/me/invoices/2026/11/INV-2026-0001.pdf
```
Run it again and you get `INV-2026-0002.pdf` next to it.

## Ready-made agents
Two finished agents ship with the plugin, so nobody has to describe the job to an AI model and hope it writes a
valid workflow: **Make an invoice** ([agents/make-invoice.yaml](agents/make-invoice.yaml), English) and
**Buat invoice** ([agents/buat-invoice.yaml](agents/buat-invoice.yaml), Indonesian). Each one:

1. asks for the client, the items (description, quantity, unit, unit price), the tax name and percent (leave
   the percent empty for no tax), the currency and your business name,
2. checks all of it first. A mistake, such as a price written in words ("seratus ribu"), a missing unit price
   or a currency that is not a three-letter code, ends the run with a message that says what to correct, for
   example *The unit price of item 1 must be a plain number such as 1500000*. Nothing is made and no number
   is used,
3. shows what it is about to make in plain words (client, currency, tax, each item), with the invoice number it
   will get and the total due, and waits for your approval (cancelling makes nothing and uses no number),
4. makes the PDF with the ready-made invoice in the usual year and month folder, under the next invoice number
   (`INV-2026-0001`, then `INV-2026-0002`),
5. and tells you the total and where the file is.

The invoice number is only used up once the PDF is saved. If the PDF cannot be made after all (for example a
file with that name was put in the folder meanwhile), the agent says so and the number stays free, so your
invoice series has no gaps. Two invoices made at the same moment each get their own number.

The items are a list of rows with titled columns (Description, Quantity, Unit, Unit price; in Indonesian
Deskripsi, Jumlah, Satuan, Harga satuan), which graphrt Desktop shows as a small table to fill in.

No step uses an AI model, so they run the same with any model, or with none. A saved brand
([Your logo, colour and wording](#your-logo-colour-and-wording)) adds your logo, colour, address and payment
details to every invoice they make.

```bash
graphrt run document-templates/agents/make-invoice.yaml --plugins . \
  -i client_name="Northwind Analytics Ltd" -i seller_name="Rina Wijaya" -i tax_percent:=20
# pauses for approval; continue with:
graphrt run document-templates/agents/make-invoice.yaml --plugins . \
  --resume document-templates/agents/make-invoice.yaml.snapshot.json --resume-input 'approve={"action":"create"}'
# Invoice INV-2026-0001 for Northwind Analytics Ltd is ready. Total due: USD 845.40.
# Saved as /home/me/invoices/2026/11/INV-2026-0001.pdf
```

[`graphrt-agents.json`](graphrt-agents.json) lists them for graphrt Desktop, which offers them on its New agent
screen while the plugin is installed (in Desktop versions that read the file; the graphrt runtime ignores it).
The format is described in [CONTRIBUTING.md](../CONTRIBUTING.md#graphrt-agentsjson-optional).

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
{ "path": "/home/me/invoices/2026/11/INV-2026-0042.pdf", "folder_path": "/home/me/invoices/2026/11",
  "relative_path": "2026/11/INV-2026-0042.pdf", "folder": "2026/11", "file_name": "INV-2026-0042.pdf",
  "size_bytes": 34120, "replaced_existing": false,
  "template": "invoice", "number": "INV-2026-0042", "page_count": 1,
  "totals": { "currency": "IDR", "subtotal": "6900000", "discount": "345000", "tax_total": "589950",
              "total": "7144950", "amount_paid": "0", "balance_due": "7144950",
              "total_text": "Rp 7.144.950", "balance_due_text": "Rp 7.144.950" } }
```

Every operation that makes a document answers with where it is: `path` (the file) and `folder_path` (its
folder) are absolute, ready for an "open file" or "open folder" button.

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
`folder` and `file_name` are patterns. The defaults are `{YYYY}/{MM}` and `{number}`; leave both empty unless
you want something else (an empty text means the default too).

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

### Your logo, colour and wording
Nothing has to be edited to make the invoice yours. Say what you want in plain words to an agent, or set `look`
on `render_pdf`:

| Option | What it does | Example |
|--------|--------------|---------|
| `logo` | Your logo above your name. A PNG or JPEG in one of your template folders, at most 2 MB and 4000 pixels a side | `"logo.png"` |
| `accent_color` | The colour of your name, the line above the items and the total. A colour name (black, grey, navy, blue, teal, green, red, maroon, purple, orange, brown, pink; also hitam, abu-abu, biru tua, biru, toska, hijau, merah, marun, ungu, oranye, cokelat, merah muda) or a code such as `#1D4ED8` | `"navy"` |
| `title` | The word at the top right | `"Tax Invoice"`, `"Faktur"`, `"Quotation"` |
| `language` | Labels, dates and number format: `en` or `id` | `"id"` |
| `labels` | Any other label text (`describe_template` lists the names) | `{"tax": "PPN", "bill_to": "Customer"}` |
| `show` | `false` hides a part: `period` (the period column), `quantity` (quantity and unit price), `payment_details` (the payment box), `notes` | `{"period": false, "notes": false}` |

```yaml
- id: invoice
  type: document-templates.render_pdf
  values: { number: INV-2026-0042, seller: { name: Rina Wijaya }, client: { name: Northwind Analytics Ltd }, items: [...] }
  look: { logo: logo.png, accent_color: navy, title: Tax Invoice, show: { period: false } }
```

A colour that is too light to read on a white page is refused with a plain message, and so is a file that is
not really a picture. Hiding a column never changes an amount.

**Say it once.** `save_brand` remembers the look, and also your own details, so later invoices need only the
client and the items:

```yaml
- id: brand
  type: document-templates.save_brand
  look: { logo: logo.png, accent_color: "biru tua", language: id }
  seller: { name: CV Kenanga Digital, address: ["Jalan Kenanga 12", "Bandung 40115"], details: ["NPWP 00.000.000.0-000.000"] }
  payment_details:
    - { label: Bank, value: Bank Contoh }
    - { label: No. rekening, value: "000 111 2222" }
  notes: ["Pembayaran paling lambat 14 hari setelah tanggal invoice."]
```

- The saved look is used for every PDF made from a template (`render_pdf`) from then on. Word templates and PDF
  forms get your details, not the look ([Your details in Word and PDF forms](#your-details-in-word-and-pdf-forms)).
  What a document says itself always wins: its own `values` over the saved details, and its own `look` over both.
- Call `save_brand` again with only what changes ("make the colour green"); everything else stays. `reset: true`
  starts again. `show_brand` shows what is saved.
- More than one business: give each a `name` (`save_brand` with `name: studio`), and ask for it with
  `brand: studio` on `render_pdf`, `fill_docx` or `fill_pdf_form`. `brand: none` makes a document without the
  saved look and details.
- The look is kept in `.document-templates/brands/` inside your documents folder. It is not a template and
  holds no layout, only the choices above.

### Your details in Word and PDF forms
`fill_docx` and `fill_pdf_form` use the same saved brand for your own details. Write these placeholders in the
Word file, or in `fields` for a form; `save_brand` and `show_brand` list the ones your brand fills
(`word_and_form_placeholders`):

| Placeholder | Filled with |
|---|---|
| `{{business.name}}`, `{{business.tagline}}` | `seller.name`, `seller.tagline` |
| `{{business.address}}`, `{{business.details}}` | the lines of `seller.address` / `seller.details`, one per line; add `\| join` for one line with commas (`\| join: " · "` for another separator) |
| `{{payment.<label>}}` | one payment detail, by its label in lowercase with `_` for spaces and other signs: `Bank` gives `{{payment.bank}}`, `No. rekening` gives `{{payment.no_rekening}}`, `Account number` gives `{{payment.account_number}}` |
| `{{#payment.details}}{{label}}: {{value}}{{/payment.details}}` | every payment detail, in Word (a table row with these tags repeats) |
| `{{notes}}` | your standard notes, one paragraph each |

`{{seller.name}}` and the other `seller.*` names work too, as in the invoice. The rules are the same as for
`render_pdf`:

- What `values` gives always wins, field by field: `values: {seller: {name: "Toko Sendiri"}}` changes only the
  name, and `values: {payment: {bank: "Bank Lain"}}` only `{{payment.bank}}`.
- The saved language sets how `{{date | date}}` and `{{amount | money}}` are written (`Rp 1.250.000` for `id`),
  unless `values` gives a `language`.
- `brand: none` uses only `values`; `brand: studio` uses another saved brand.
- With a saved brand a Word file may need no `values` at all, e.g. a letterhead with only `{{business.name}}`.

The saved **logo, accent colour, title, labels and hidden parts are not used** in Word files and PDF forms. Those
files keep the layout they were made with: a Word template has its own logo and colours, and a PDF form's boxes
cannot take a picture or another colour. Put your logo into the Word template once, in Word.

For a different layout (other columns, another arrangement), make your own version of the invoice:

### Your own version of the invoice
`save_template_copy` (optionally with `name: Quotation`) saves `Templates/invoice.json` in your documents folder
and answers with its `path`. Change the file in a text editor: `labels` are the texts, `styles` the colours and
sizes, `content` the layout ([TEMPLATES.md](TEMPLATES.md)). Then pass the `path` as `template` to `render_pdf`.
A second copy with the same name is saved as `invoice-2.json`; your changes are never overwritten.
A copy keeps the accent colour in one place (`"colors": {"accent": "#1C1C1A"}`), and `look` and a saved brand
work on a copy just as on the original.

### Running numbers
`next_number` with `pattern: "INV-{YYYY}-{SEQ:4}"` returns `INV-2026-0001`, then `INV-2026-0002`. The count
belongs to the pattern with its date filled in, so it restarts each year here, or each month with `{MM}` in the
pattern. `{ROMAN}` is the month as a Roman numeral (`{SEQ:3}/INV/{ROMAN}/{YYYY}` gives `007/INV/XI/2026`).
`start_at: 38` starts a new counter at 38, to continue an existing series. `preview: true` shows the next number
without using it.

Counters are kept in `.document-templates/numbering.json` inside the output folder. A number from `next_number`
is used up when it is issued, even if the document is then never made; edit that file to give one back.

For an invoice made with `render_pdf`, give the pattern to `render_pdf` itself instead, so that a failed invoice
never leaves a gap in the series:

```yaml
- id: check
  type: document-templates.check_values      # reads only: no file, no number
  number_pattern: "INV-{YYYY}-{SEQ:4}"
  values: { seller: { name: Rina Wijaya }, client: { name: Northwind Analytics Ltd }, items: [...] }
# check.data.ok is true, or check.data.problem says what is wrong; check.data.number is the number it would get
- id: invoice
  type: document-templates.render_pdf
  number_pattern: "INV-{YYYY}-{SEQ:4}"
  values: { seller: { name: Rina Wijaya }, client: { name: Northwind Analytics Ltd }, items: [...] }
```

`render_pdf` draws the invoice with the next free number and uses that number up only at the moment the PDF is
saved; when saving fails, the number is given back. When another invoice takes the number first, the invoice is
drawn again with the following one. The series follows the invoice's `date` (a 2027 invoice gets a 2027
number), and `number_start_at` continues an existing series. `values` may not also give a `number`.

### A PDF form
```yaml
- id: form
  type: document-templates.fill_pdf_form
  template: invoice-form.pdf
  fields: { InvoiceNo: "{{number}}", Client: "{{client.name}}", Total: "{{totals.total | money}}", Paid: true }
  values: { number: INV-2026-0042, client: { name: PT Maju Bersama }, items: [{ description: Jasa, amount: 500000 }] }
```
`describe_template` lists the form's field names, with each field's kind, its `options` and its `max_length`.
Keep the field map in a `.json` file and pass `fields_file` to reuse it. A form has as many rows as it was drawn
with: for the third item use `{{items.2.description}}`.

- A check box takes `true` or `false`; a radio group, a drop-down and a list take one of their `options`
  (a list also several, as an array). A value that is not an option, or longer than `max_length`, is refused.
- Boxed fields (one character per box, such as a tax number) are filled box by box.
- Read-only fields can be filled: read-only stops a person typing in a viewer, not a workflow.
- Signature fields and buttons cannot be filled. With `flatten` they are removed like every other field.

### A Word template
Type the placeholders in Word, in a `.docx` or in a Word template (`.dotx`, the format Microsoft's own templates
come in): `{{client.name}}`, `{{date | date}}`, `{{totals.total | money}}`. For line items,
put `{{#items}}` in the first cell of a table row and `{{/items}}` in its last cell; the row repeats.
`{{#flags.has_taxes}}...{{/flags.has_taxes}}` shows a part only when there are taxes, `{{^notes}}...{{/notes}}`
only when there are no notes.

Placeholders work in the text, in tables, in headers and footers, in text boxes and inside content controls
(the grey "click here" fields of Microsoft's templates; a field you put a placeholder in becomes ordinary text
in the result, so Word no longer selects and clears it on a click). Word may store a placeholder in several pieces or turn
`"` into `“ ”`; both are fine. The result is always a `.docx`. Your saved details fill `{{business.name}}`,
`{{payment.bank}}` and the like ([Your details in Word and PDF forms](#your-details-in-word-and-pdf-forms)).

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
  one. Images must be PNG or JPEG by content (a logo chosen
  with `look` or a brand also at most 2 MB and 4000 pixels a side), backgrounds and forms PDFs by content, Word files plain `.docx`
  or `.dotx` (no macros), checked for zip bombs before unpacking. `DOCUMENT_TEMPLATES_FONTS` is configuration, not an
  argument, so those files may be anywhere.
- **Outputs:** every part of a folder or file name is reduced to a plain name, so no value can add a folder level
  or leave the output folder. Folders are created one level at a time under the real output folder and
  re-checked, so a link planted inside it leads nowhere. A document is written to a private staging file and
  published with `link()`, which cannot replace a file. Overwriting replaces only a plain regular file with one
  link, atomically.
- **Isolation:** laying out pages and parsing PDFs, Word files, images and fonts runs in a short-lived child
  process that gets bytes over IPC. `DOCUMENT_TEMPLATES_MAX_MEMORY_MB` is enforced as the V8 heap cap and by an
  RSS watchdog; on timeout, cancel or the memory budget the child is killed with SIGKILL. The watchdog reads the
  child's memory from `/proc` on Linux, with `ps` on macOS and with `tasklist` on Windows (there a reading
  takes longer, so memory is checked a few times a second instead of twenty).
- **Passwords:** a PDF's password travels from the call to the worker process in memory only (never on a
  command line, in an environment variable or in a file on disk) and is gone when the worker exits. Only the
  password that was given, or none, is ever tried.
- **Caps:** input and output bytes, 2 MiB of values, 2000 line items, 100000 layout parts after loops are
  unrolled, 20 images, form fields (`DOCUMENT_TEMPLATES_MAX_FORM_FIELDS`), pages per document
  (`DOCUMENT_TEMPLATES_MAX_PAGES`).
- **Look and brands:** `look` and a saved brand are choices, not layout: a colour must be a hex code or a known
  name and dark enough to read, texts have length limits and no control characters, and a logo is only a path
  that is read through the allowed folders like every other input. A brand file is checked again each time it
  is read, so one edited by hand into something else is refused; it is written only inside
  `.document-templates/brands/` of the output folder, never through a link.
- **Ready-made agents:** the shipped workflows use only the start form, an approval, this plugin's own
  operations and text steps: no model, no network, no shell, no other plugin. Before the approval they only
  read (`check_values` writes no file and uses no number); the approval comes before a number is used and
  before anything is created; `npm test` checks this for every agent.
- **Agents vs nodes:** all ten operations are available as tools. They read only allowlisted files and add new
  files to the output folder (setting `DOCUMENT_TEMPLATES_OUTPUT_DIR` is the opt-in for writing).
  `save_template_copy` writes only into `Templates` there and never over a file.
  `save_brand` replaces only its own small settings file there; what it saves (including payment details) is
  what a tool could also pass to `render_pdf`, `fill_docx` or `fill_pdf_form` directly, and every document's result names the brand it used.
  `if_exists: overwrite` is for workflow nodes only; a tool call that asks for it gets `permission_denied`.
  `next_number` uses up a number each time it is called without `preview`; `render_pdf` with `number_pattern`
  uses one only for a saved PDF. `check_values` reads only.

## Errors
| Kind | When |
|------|------|
| `setup_required` | npm packages not installed, `DOCUMENT_TEMPLATES_OUTPUT_DIR` unset or missing, `DOCUMENT_TEMPLATES_INPUT_DIRS` unset when a file is read, a font file unreadable |
| `not_found` | A template, image, logo, background or values file is missing or outside the allowed folders; a `brand` that was never saved |
| `invalid_input` | Required values missing, an amount that is not a plain number, a template with an unknown property or malformed placeholder, a PDF without form fields, an XFA-only PDF, a protected PDF whose password is missing or wrong or whose publisher forbids filling it in, an unknown form field, a value a form field does not accept, a character no font has, a file that already exists, over a cap, a `look` with an unknown option, a colour that is not a colour or is too light, a logo that is not a PNG or JPEG or is too large, a saved brand that was damaged by hand |
| `permission_denied` | A tool call asked for `if_exists: overwrite` |
| `timeout` / `cancelled` | The worker passed `DOCUMENT_TEMPLATES_TIMEOUT_MS` or the call was cancelled; nothing is saved |
| `plugin_error` | The worker crashed, the document could not be written, or the numbering file is locked |

`check_values` does not fail for a mistake in the details: `invalid_input`, `not_found` and `permission_denied`
come back as `ok: false` with the `problem` in plain words. Only what is not the details' fault (no documents
folder set up, a crashed worker) fails.

### Messages in Indonesian
What a person reads when something is wrong with an invoice's details, its number, its file or its folder is
written in the document's language: English, or Indonesian for a document in Indonesian. The language is the
first of:

1. `language` in the document's values (`render_pdf`, `check_values`, `fill_docx`, `fill_pdf_form`), or the
   `language` parameter of `next_number`,
2. `language` in the call's `look`,
3. the language of your saved brand (`save_brand` with `look: {language: id}`),
4. English.

So `Harga satuan item 1 harus berupa angka biasa seperti 1500000 …`, `Mata uang harus berupa kode tiga huruf
seperti IDR atau USD, bukan "Rp"` or `"2026/11/INV-2026-0003.pdf" sudah ada; tidak ada yang disimpan` instead of
the English text. Only the text changes: the error's kind (the table above) is the same in both languages, so an
app that reacts to the kind works the same. Messages meant for whoever sets up or builds templates (a template's
own structure, a crashed worker) stay in English. The **Buat invoice** agent writes its invoices in Indonesian,
so everything it tells you is in Indonesian.

## Tested with
- **Text read back from the PDF:** letter-spaced labels such as TOTAL DUE are copied, searched and read aloud as
  words (checked with pdf.js, PDFium, Poppler, MuPDF, pdfminer, pypdf and Ghostscript).
- **Word:** Microsoft's own invoice and letter templates (`.dotx`) and documents saved by Word 2007, Word 2016 and
  Word for Mac, with placeholders in content controls, headers, footers, text boxes and repeating table rows.
- **PDF forms:** public forms made with Adobe Acrobat, InDesign and LiveCycle Designer (IRS W-9, W-4, 1040, SS-4
  and 8949, USCIS I-9, State Department DS-11, OPM SF 3102, GSA SF 1449, VA 10-10EZ, FDIC 7200/09).
- **Protected PDF forms:** USCIS G-1145, I-765 and G-28 (AES 128 bit), OPM SF 181 and the Australian Home
  Affairs Form 80 (RC4 128 bit), filled in with and without `flatten` and opened with Poppler, Ghostscript and
  pdf.js. Password-protected forms in all four formats are made in the tests.
- **Large forms:** OPM SF 86 (6197 fields, 136 pages), every field filled.
- **Ready-made agents:** both validated and run with the released graphrt CLI 0.6.2: from start to finished PDF,
  cancelled, and with wrong details (a price in words, a missing unit price, a bad currency), which end in a
  plain message with no file and no number used.
- **Systems:** the tests run on Linux, Windows and macOS.

## Fonts
[Inter](https://rsms.me/inter/) and [EB Garamond](https://github.com/octaviopardo/EBGaramond12) ship in `fonts/`
under the SIL Open Font License 1.1; the licence texts are next to them.

## License
Apache-2.0
