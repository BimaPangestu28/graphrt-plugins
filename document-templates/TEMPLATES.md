# Layout templates

A layout template is a JSON file that describes a page: texts, columns, tables, images and lines, with
`{{placeholders}}` where the values go. `render_pdf` draws it as a PDF. The built-in `invoice` is such a file
([templates/invoice.json](templates/invoice.json)); the quickest way to your own design is to save it
(`describe_template` with `include_layout: true` returns it) and change it.

A template is data. It cannot run code, read files, or load anything from the network.

## A small example
```json
{
  "format": "graphrt-document-template",
  "version": 1,
  "name": "receipt",
  "calculate": "invoice",
  "page": { "size": "A5", "margins": [40, 40, 40, 50] },
  "defaults": { "font": "sans", "fontSize": 10 },
  "styles": { "title": { "font": "serif", "fontSize": 20, "bold": true } },
  "fields": [{ "name": "number", "required": true, "description": "Receipt number" }],
  "content": [
    { "text": "Receipt {{number}}", "style": "title" },
    { "text": "{{date | date}}", "color": "#666666", "margin": [0, 2, 0, 12] },
    {
      "table": {
        "headerRows": 1,
        "widths": ["*", 90],
        "body": [
          [{ "text": "Item", "bold": true }, { "text": "Amount", "bold": true, "alignment": "right" }],
          { "$each": "items", "as": "item", "do": ["{{item.description}}", { "text": "{{item.amount | amount}}", "alignment": "right" }] }
        ]
      },
      "layout": { "lines": "rows", "padding": [0, 6, 0, 6] }
    },
    { "text": "Total {{totals.total | money}}", "bold": true, "alignment": "right", "margin": [0, 10, 0, 0] }
  ],
  "footer": { "text": "{{page.number}} / {{page.count}}", "alignment": "center" }
}
```

## Top level
| Key | Meaning |
|-----|---------|
| `format`, `version` | Always `"graphrt-document-template"` and `1` |
| `name`, `description` | Shown by `describe_template`; the name is the `{template}` token of file names |
| `calculate` | `"invoice"`: the values need `items`, and line amounts, `totals` and `flags` are calculated. Default `"none"` |
| `page` | `size` (`A3`, `A4`, `A5`, `LETTER`, `LEGAL` or `{"width", "height"}` in points), `orientation`, `margins` `[left, top, right, bottom]`, `background_color`, `background_pdf` (a PDF inside the allowed input folders, drawn under every page) |
| `defaults` | Text style of the whole document |
| `styles` | Named styles, used with `"style": "name"` |
| `labels` | Fixed texts per language: `{"en": {...}, "id": {...}}`, read as `{{labels.name}}`. The document's `language` picks one; the values' own `labels` replace single texts |
| `fields` | What the template needs: `[{"name", "required", "description"}]`. Required fields are checked before anything is drawn |
| `sample_values` | Example values, shown by `describe_template` |
| `info` | PDF `title`, `author`, `subject` |
| `watermark` | A text, or `{"text", "color", "opacity", "bold", "angle", "fontSize"}`. Empty text means none |
| `header`, `footer` | Drawn on every page, inside the top and bottom margins. `{{page.number}}` and `{{page.count}}` work here |
| `content` | The list of parts that make up the document |
| `bottom` | A block pinned to the foot of the last page (notes, signatures) |

Sizes are in points (72 per inch; A4 is 595 x 842). Colours are hex: `#1C1C1A`.

## Placeholders
`{{path}}` reads a value: `{{client.name}}`, `{{items.0.description}}`. A missing value is empty. A list of texts
becomes lines. Filters follow a `|`:

| Filter | Example | Result |
|--------|---------|--------|
| `money` | `{{totals.total \| money}}` | `Rp 1.500.000`, `USD 1,050.00`; `money:code` or `money:symbol` forces the form |
| `amount` | `{{item.amount \| amount}}` | `1.500.000` (the currency's decimals, no symbol) |
| `number` | `{{item.quantity \| number}}` | `2,5`; `number:2` fixes the decimals |
| `percent` | `{{tax.rate \| percent}}` | `11%` |
| `date` | `{{date \| date}}` | `27 November 2026`; `date:medium`, `date:short`, `date:iso` |
| `upper`, `lower` | `{{labels.total \| upper}}` | `TOTAL` |
| `default` | `{{terms \| default:"On receipt"}}` | The fallback when the value is empty |
| `join` | `{{tags \| join:", "}}` | A list on one line |

Conditions also accept `not value`, `value == "text"` and `value != "text"`. There is nothing else: no arithmetic
and no functions.

With `"calculate": "invoice"` these values are added: `items[].number`, `items[].amount`,
`totals.subtotal`, `.discount`, `.taxable`, `.taxes[]` (`name`, `rate`, `amount`), `.tax_total`, `.shipping`,
`.total`, `.amount_paid`, `.balance_due`, and `flags.has_period`, `.has_quantity`, `.has_discount`, `.has_taxes`,
`.show_tax_note`, `.has_shipping`, `.has_amount_paid`. `{{today}}` is always there.

## Loops and conditions
Both are entries of a list (`content`, `stack`, `columns`, a table `body`, a row, `widths`, `text`).

```json
{ "$each": "items", "as": "item", "do": { "text": "{{loop.number}}. {{item.description}}" } }
```
adds one entry per item. Inside, `loop.number`, `loop.index`, `loop.first` and `loop.last` are available.
In a table body, `do` is a row. `"chunk": 2` hands the items over in pairs (`{{pair.0.label}}`, `{{pair.1.label}}`),
for grids. One text where a list is expected loops once.

```json
{ "$if": "flags.has_taxes", "then": { "text": "Tax included" }, "else": { "text": "No tax" } }
```
adds `then` or `else`, or nothing. It also works for a single table column: put the same `$if` around the
column's width and around its cell in every row.

## Parts
| Part | Example |
|------|---------|
| Text | `"plain"` or `{ "text": "{{client.name}}", "bold": true }`; mixed styles: `{ "text": ["Total ", { "text": "{{totals.total \| money}}", "bold": true }] }` |
| Stack | `{ "stack": [ ... ] }`: parts under each other |
| Columns | `{ "columns": [{ "width": 180, "text": "left" }, { "width": "*", "text": "rest" }], "columnGap": 12 }` |
| Table | `{ "table": { "headerRows": 1, "widths": ["*", 80], "body": [[...], [...]], "dontBreakRows": true }, "layout": { ... } }` |
| Image | `{ "image": "{{seller.logo}}", "fit": [160, 44] }`: a PNG or JPEG inside the allowed input folders. Wrap it in `$if` when the value is optional |
| Line | `{ "rule": { "color": "#DDDDDD", "thickness": 0.5, "margin": [0, 8, 0, 8] } }` |
| Shapes | `{ "canvas": [{ "type": "rect", "x": 0, "y": 0, "w": 100, "h": 40, "color": "#F4F3EE" }] }` (`line`, `rect`, `ellipse`) |
| QR code | `{ "qr": "{{payment.qr_text}}", "fit": 90 }` |
| Lists | `{ "ul": ["one", "two"] }`, `{ "ol": [...] }` |

Every part may have: `font` (`sans`, `serif`, or the file name without extension of a font from
`DOCUMENT_TEMPLATES_FONTS`), `fontSize`, `bold`, `italics` (drawn upright: the bundled fonts have no italic),
`color`, `background`, `alignment`, `characterSpacing`, `lineHeight`, `decoration`, `opacity`, `noWrap`,
`fontFeatures`, `margin`, `width`, `height`, `fit`, `style`, `pageBreak` (`before`, `after`), `unbreakable`,
`absolutePosition` and `relativePosition` (`{"x", "y"}`), and in tables `colSpan`, `rowSpan`, `fillColor`,
`border` and `borderColor`. Anything else is refused with the name of the property.

`absolutePosition` places a part at fixed coordinates on the page, which is how to write into the boxes of a
pre-printed `background_pdf`.

Numbers are drawn with tabular figures (`"fontFeatures": ["tnum"]` is the default) so that `1.277.000` stays
readable and columns line up.

### Table layout
`"layout": { "lines": "rows", "line_width": 0.5, "line_color": "#DDDDDD", "header_line_width": 1,
"header_line_color": "#000000", "padding": [0, 6, 0, 6], "column_gap": 12 }`

`lines` is `none` (default), `rows` (a line under every row), `header` (only under the header rows) or `grid`
(all lines, including the outer border). `padding` is `[left, top, right, bottom]` of every cell.

## Limits
A template file may be 2 MiB. After loops are unrolled a document may have 100000 parts, 40 levels of nesting,
20 different images, and as many pages as `DOCUMENT_TEMPLATES_MAX_PAGES` allows.
