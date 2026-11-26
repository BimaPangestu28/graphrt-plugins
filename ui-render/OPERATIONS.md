# ui-render operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `ui-render.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `show_adaptive_card` | Shows the user an Adaptive Card (graphrt UI block; card JSON with type "AdaptiveCard" and version "1.5"). Supported: TextBlock, RichTextBlock, Image, ImageSet, Container, ColumnSet/Column, FactSet, ActionSet, Table, Input.Text/Number/Date/Time/Toggle/ChoiceSet; Action.Submit, Action.Execute, Action.OpenUrl (https or mailto), Action.ShowCard, Action.ToggleVisibility. Images must be https or data: PNG/JPEG/GIF/WebP. No ${...} templates: write the values into the text. Use it for summaries, receipts and records; buttons only work in a workflow's ask-me-first step (human-input card). | heading, **card**, fallback_text |
| `show_chart` | Shows the user a bar, line, area, pie or donut chart (graphrt UI block). Give the categories (x_values) and one or more series with one number (or null) per category, or give rows plus x_key and y_keys. Pie and donut take one series of non-negative values. | **chart_type**, heading, subtitle, x_label, x_values, series, rows, x_key, y_keys, y_label, y_format, currency, stacked, horizontal, fallback_text |
| `show_table` | Shows the user a table (graphrt UI block). Give rows (objects) and optionally columns (key, label, format); without columns every field becomes a column. Formats: text, number, compact, percent, currency, date, status (a coloured pill). | heading, subtitle, **rows**, columns, fallback_text |
| `show_stats` | Shows the user KPI tiles (graphrt UI block): up to 12 items, each with a label, a value (number or short text), an optional format and currency, an optional delta (change, delta_format number or percent), trend (up, down, flat), good (which direction is good) and caption. | heading, subtitle, **items**, fallback_text |
