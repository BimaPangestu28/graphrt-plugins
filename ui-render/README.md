# ui-render

**Status:** beta · **ToS risk:** none. Local only, no dependencies; unit-tested with graphrt-ui's shared fixtures and over the stdio protocol. See [plugin status](../README.md#plugin-status).

## Overview
A [graphrt](https://github.com/Graphrt/graphrt) plugin for **rich visual output**. Workflows and agents can show
people an Adaptive Card, a chart, a table, KPI tiles or a diagram instead of a wall of text. Each operation builds one
[graphrt UI block](https://github.com/Graphrt/graphrt/blob/main/docs/workflow-format.md#ui-blocks) (an object with
`"$ui": "<kind>"`) and checks it with the same rules as graphrt's `graphrt-ui` crate. Hosts such as graphrt
Desktop validate it again and render it in their own theme.

- As a **workflow node**, the block is the node's `data` output. Pass it on with `{{#node.data#}}`: as an `end`
  output (it is then shown in the run result), or as a `human-input` step's `card`, which makes the card's buttons
  answer the step.
- As an **agent tool**, the block goes only into the tool's structured result, which the `agent` node collects in
  its `ui` output. The model gets a one-line summary ("Shown to the user: bar chart "Sales" with 2 series over 6
  categories..."), so it does not pay tokens to read the data back.

## Features
- **`show_adaptive_card`:** an [Adaptive Card](https://adaptivecards.io) 1.0–1.6 (`card`). Supported:
  TextBlock, RichTextBlock, Image, ImageSet, Container, ColumnSet/Column, FactSet, ActionSet, Table, Input.Text,
  Input.Number, Input.Date, Input.Time, Input.Toggle, Input.ChoiceSet; Action.Submit, Action.Execute,
  Action.OpenUrl, Action.ShowCard, Action.ToggleVisibility. Other element types need a `fallback`.
- **`show_chart`:** `chart_type` bar, line, area, pie or donut. Give `x_values` and `series` (one value or `null`
  per category), or `rows` with `x_key` and `y_keys` (straight from a database query). Options: `y_format` (number,
  compact, percent, currency + `currency`), `stacked`, `horizontal`, axis labels.
- **`show_table`:** `rows` and optional `columns` (key, label, align, format: text, number, compact, percent,
  currency, date, status). Without columns, every field becomes one.
- **`show_stats`:** up to 12 KPI tiles: label, value, format, and a `delta` with `trend` and `good`.
- **`show_diagram`:** a diagram written as [Mermaid](https://mermaid.js.org) text (`source`): flowchart, sequence,
  class, state or entity diagram, Gantt chart, pie, mind map, timeline, quadrant chart or git graph. Text only: see
  Safety. A ```` ```mermaid ```` fence around the source is dropped. Needs a graphrt Desktop newer than 0.2.0 (older
  versions say the block could not be shown).

All take `heading`, `subtitle` (not cards) and `fallback_text`, plain text for channels that cannot show blocks.
On WhatsApp and other text channels the host sends the block as text (graphrt-ui's `fallback`): a card becomes its
text with numbered choices for its buttons, a table compact lines, a chart a short summary or an image, and a
diagram its `fallback_text`. So give diagrams a `fallback_text` when the agent talks to customers on chat.
(`heading` maps to the block's `title`: graphrt reserves `title` on every node.) Full operation reference:
[OPERATIONS.md](OPERATIONS.md).

## Prerequisites
- Node.js 20 or newer. No npm dependencies.

## Installation
```bash
graphrt plugin install ./ui-render
```

## Configuration
None. The plugin reads no environment variables, makes no network calls and touches no files.

## Quick Start
```bash
graphrt run ui-render/example.yaml --plugins .
```

## Usage
```yaml
- id: chart
  type: ui-render.show_chart
  chart_type: bar
  heading: Penjualan per bulan
  rows: "{{#sales_query.data.rows#}}"
  x_key: month
  y_keys: [online, offline]
  y_format: currency
  currency: IDR
```
The node's `data`:
```json
{ "$ui": "chart", "version": 1, "type": "bar", "title": "Penjualan per bulan",
  "x": { "values": ["Jan", "Feb"] }, "y": { "format": "currency", "currency": "IDR" },
  "series": [{ "name": "Online", "values": [42000000, 51000000] }, { "name": "Offline", "values": [30000000, 28000000] }] }
```

An approval card whose buttons answer the step (`Action.Submit` ids are the step's action ids; card inputs come
back as the step's outputs):
```yaml
- id: refund_card
  type: ui-render.show_adaptive_card
  card:
    type: AdaptiveCard
    version: "1.5"
    body:
      - { type: TextBlock, text: "Refund **Rp 250.000** to Sari?", wrap: true }
      - { type: Input.Text, id: note, label: Note to customer }
    actions:
      - { type: Action.Submit, id: approve, title: Approve, style: positive }
      - { type: Action.Submit, id: reject, title: Reject }
- id: ask
  type: human-input
  prompt: Approve the refund?
  card: "{{#refund_card.data#}}"
  actions: [{ id: approve, title: Approve }, { id: reject, title: Reject }]
```

## Safety
- **No network, files or secrets:** the plugin only shapes and checks JSON.
- **Strict blocks:** unknown fields are errors (no styles, colours, HTML or scripts). Images must be `https` or
  `data:` PNG/JPEG/GIF/WebP (SVG is refused: it can carry scripts). Links must be `https` or `mailto`.
  Adaptive Card `${...}` templates are refused. Blocks are capped at 256 KiB, 10 000 categories, 20 series,
  1000 table rows, 12 tiles and 400 card elements nested at most 12 deep.
- **Diagrams are text, not code:** a diagram source may hold no HTML (except `<br>`), no `click`, `link` or
  `callback` statements, no `%%{init}%%` directives or front matter (they could loosen the renderer), no
  `style` / `classDef` / `linkStyle` colours (the host themes the diagram), no images in nodes and no
  `javascript:` / `data:` URLs. At most 20 000 characters and 500 lines. The host renders Mermaid with
  `securityLevel: "strict"` and HTML labels off.
- **Agents vs nodes:** every operation is a read-only tool. Showing a card never acts on anything; buttons only
  work in a workflow's `human-input` step, which the workflow author put there.
- The host (graphrt Desktop) validates every block again with graphrt-ui before rendering and never fetches remote
  images or scripts. `test/fixtures` is a copy of graphrt-ui's shared fixtures, so both validators stay in step.

## Errors
| Kind | When |
|------|------|
| `invalid_input` | The block breaks a rule. The message has a JSON Pointer and says what to change (for example `at /series/0/values: has 5 values but x.values has 6`). |
| `plugin_error` | Another failure |

## License
Apache-2.0
