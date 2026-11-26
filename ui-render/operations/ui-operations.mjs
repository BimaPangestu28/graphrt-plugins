/**
 * ui-render operations: each builds one graphrt UI block (see lib/ui-blocks.mjs), checks it like the host will,
 * and returns it as `data`. Workflow nodes pass `{{#node.data#}}` on (an `end` output, a `human-input` `card`);
 * agent tools return the block for the person and only a short summary for the model (see plugin.mjs).
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { CHART_TYPES, COLUMN_FORMATS, LIMITS, NUMBER_FORMATS, UiBlockError, VERSION, validateUiBlock } from "../lib/ui-blocks.mjs";

const HEADING = { type: "string", maxLength: 300, description: "Title shown above the block (`title` is a graphrt node key, so it is called heading)" };
const SUBTITLE = { type: "string", maxLength: 300, description: "Smaller line under the title" };
const FALLBACK_TEXT = { type: "string", maxLength: 10000, description: "Plain text for channels that cannot show it (chat apps, email)" };
const CURRENCY = { type: "string", description: "ISO 4217 code for the currency format, e.g. IDR or USD" };

/** Builds the block, validates it, and turns a validation failure into an `invalid_input` the caller can fix. */
function finish(block) {
  try {
    return { data: validateUiBlock(block) };
  } catch (error) {
    if (error instanceof UiBlockError) throw new PluginError(error.message, { kind: "invalid_input" });
    throw error;
  }
}

/** Drops undefined and empty-string fields so optional parameters never reach the block. */
function compact(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== ""));
}

function invalid(message) {
  return new PluginError(message, { kind: "invalid_input" });
}

/** "monthly_revenue" → "Monthly revenue". */
export function humanizeKey(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toNumberOrNull(value, path) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) throw invalid(`${path} is \`${value}\`, not a number`);
  return number;
}

/**
 * Chart series from records: one category per row (`x_key`), one series per `y_keys` entry.
 *
 * @param rows - Records, e.g. a database query result (Array<object>)
 * @param xKey - Field with the category of each row (string)
 * @param yKeys - Fields with the numbers, one series each (Array<string>)
 * @returns `{categories, series}` (object)
 * @throws PluginError invalid_input - When a key is missing everywhere or a value is not a number
 */
export function seriesFromRows(rows, xKey, yKeys) {
  if (!xKey || !Array.isArray(yKeys) || yKeys.length === 0) throw invalid("`rows` needs `x_key` and at least one `y_keys` entry");
  for (const key of [xKey, ...yKeys]) {
    if (!rows.some((row) => row && typeof row === "object" && key in row)) throw invalid(`no row has the field \`${key}\``);
  }
  const categories = rows.map((row, index) => {
    const category = row?.[xKey];
    return typeof category === "number" ? category : String(category ?? `#${index + 1}`);
  });
  const series = yKeys.map((key) => ({ name: humanizeKey(key), values: rows.map((row, index) => toNumberOrNull(row?.[key], `rows[${index}].${key}`)) }));
  return { categories, series };
}

const chartOperation = {
  name: "show_chart",
  title: "Show a chart",
  description:
    "Shows the user a bar, line, area, pie or donut chart (graphrt UI block). Give the categories (x_values) and one or more series " +
    "with one number (or null) per category, or give rows plus x_key and y_keys. Pie and donut take one series of non-negative values.",
  parameters: {
    type: "object",
    properties: {
      chart_type: { type: "string", enum: CHART_TYPES, description: "bar, line, area, pie or donut" },
      heading: HEADING,
      subtitle: SUBTITLE,
      x_label: { type: "string", maxLength: 300, description: "Label of the category axis" },
      x_values: { type: "array", items: { type: ["string", "number"] }, maxItems: LIMITS.categories, description: "Categories, e.g. [\"Jan\", \"Feb\", \"Mar\"]" },
      series: {
        type: "array",
        maxItems: LIMITS.series,
        items: {
          type: "object",
          properties: { name: { type: "string" }, values: { type: "array", items: { type: ["number", "null"] } } },
          required: ["name", "values"],
        },
        description: "Series, each with a name and one value per category, e.g. [{\"name\": \"2026\", \"values\": [120, 150, 90]}]",
      },
      rows: { type: "array", items: { type: "object" }, maxItems: LIMITS.categories, description: "Instead of x_values and series: records, one category per row" },
      x_key: { type: "string", description: "With rows: the field holding each row's category" },
      y_keys: { type: "array", items: { type: "string" }, maxItems: LIMITS.series, description: "With rows: the numeric fields, one series each" },
      y_label: { type: "string", maxLength: 300, description: "Label of the value axis" },
      y_format: { type: "string", enum: NUMBER_FORMATS, description: "How values are written: number, compact (1.2K), percent (12.5 means 12.5%) or currency" },
      currency: CURRENCY,
      stacked: { type: "boolean", description: "Stack the series (bar and area)" },
      horizontal: { type: "boolean", description: "Horizontal bars (bar)" },
      fallback_text: FALLBACK_TEXT,
    },
    required: ["chart_type"],
  },
  run: async ({ args }) => {
    const fromRows = Array.isArray(args.rows) && args.rows.length > 0;
    if (fromRows && (args.x_values || args.series)) throw invalid("give either rows (with x_key and y_keys) or x_values and series, not both");
    const { categories, series } = fromRows ? seriesFromRows(args.rows, args.x_key, args.y_keys) : { categories: args.x_values, series: args.series };
    if (!Array.isArray(categories) || !Array.isArray(series)) throw invalid("give x_values and series, or rows with x_key and y_keys");
    const y = compact({ label: args.y_label, format: args.y_format, currency: args.currency });
    return finish(compact({
      $ui: "chart", version: VERSION, type: args.chart_type, title: args.heading, subtitle: args.subtitle, fallback_text: args.fallback_text,
      x: compact({ label: args.x_label, values: categories }),
      ...(Object.keys(y).length > 0 ? { y } : {}),
      series,
      stacked: args.stacked, horizontal: args.horizontal,
    }));
  },
};

/**
 * Columns for rows that came without any: the keys in first-seen order (at most 20), numbers right-aligned.
 *
 * @param rows - Records (Array<object>)
 * @returns Column definitions (Array<object>)
 */
export function inferColumns(rows) {
  const keys = [];
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) if (!keys.includes(key)) keys.push(key);
  }
  return keys.slice(0, LIMITS.columns).map((key) => {
    const isNumeric = rows.every((row) => row?.[key] === undefined || row?.[key] === null || typeof row[key] === "number");
    return compact({ key, label: humanizeKey(key), format: isNumeric ? "number" : undefined });
  });
}

const tableOperation = {
  name: "show_table",
  title: "Show a table",
  description:
    "Shows the user a table (graphrt UI block). Give rows (objects) and optionally columns (key, label, format); " +
    "without columns every field becomes a column. Formats: text, number, compact, percent, currency, date, status (a coloured pill).",
  parameters: {
    type: "object",
    properties: {
      heading: HEADING,
      subtitle: SUBTITLE,
      rows: { type: "array", items: { type: "object" }, maxItems: LIMITS.rows, description: "Records; values are text, numbers, true/false or null" },
      columns: {
        type: "array",
        maxItems: LIMITS.columns,
        items: {
          type: "object",
          properties: {
            key: { type: "string" }, label: { type: "string" }, align: { type: "string", enum: ["left", "center", "right"] },
            format: { type: "string", enum: COLUMN_FORMATS }, currency: { type: "string" },
          },
          required: ["key", "label"],
        },
        description: "Columns in order; each shows the row field with the same key",
      },
      fallback_text: FALLBACK_TEXT,
    },
    required: ["rows"],
  },
  run: async ({ args }) => {
    const columns = Array.isArray(args.columns) && args.columns.length > 0 ? args.columns : inferColumns(args.rows);
    if (columns.length === 0) throw invalid("the rows have no fields; give columns or rows with fields");
    return finish(compact({ $ui: "table", version: VERSION, title: args.heading, subtitle: args.subtitle, fallback_text: args.fallback_text, columns, rows: args.rows }));
  },
};

const statsOperation = {
  name: "show_stats",
  title: "Show KPI tiles",
  description:
    "Shows the user KPI tiles (graphrt UI block): up to 12 items, each with a label, a value (number or short text), an optional format " +
    "and currency, an optional delta (change, delta_format number or percent), trend (up, down, flat), good (which direction is good) and caption.",
  parameters: {
    type: "object",
    properties: {
      heading: HEADING,
      subtitle: SUBTITLE,
      items: {
        type: "array",
        minItems: 1,
        maxItems: LIMITS.statItems,
        items: {
          type: "object",
          properties: {
            label: { type: "string" }, value: { type: ["number", "string"] }, format: { type: "string", enum: NUMBER_FORMATS },
            currency: { type: "string" }, delta: { type: "number" }, delta_format: { type: "string", enum: ["number", "percent"] },
            trend: { type: "string", enum: ["up", "down", "flat"] }, good: { type: "string", enum: ["up", "down"] }, caption: { type: "string" },
          },
          required: ["label", "value"],
        },
        description: "Tiles, e.g. [{\"label\": \"Revenue\", \"value\": 125000000, \"format\": \"currency\", \"currency\": \"IDR\", \"delta\": 12.5, \"delta_format\": \"percent\"}]",
      },
      fallback_text: FALLBACK_TEXT,
    },
    required: ["items"],
  },
  run: async ({ args }) =>
    finish(compact({ $ui: "stats", version: VERSION, title: args.heading, subtitle: args.subtitle, fallback_text: args.fallback_text, items: args.items })),
};

const adaptiveCardOperation = {
  name: "show_adaptive_card",
  title: "Show an Adaptive Card",
  description:
    "Shows the user an Adaptive Card (graphrt UI block; card JSON with type \"AdaptiveCard\" and version \"1.5\"). Supported: TextBlock, " +
    "RichTextBlock, Image, ImageSet, Container, ColumnSet/Column, FactSet, ActionSet, Table, Input.Text/Number/Date/Time/Toggle/ChoiceSet; " +
    "Action.Submit, Action.Execute, Action.OpenUrl (https or mailto), Action.ShowCard, Action.ToggleVisibility. Images must be https or data: " +
    "PNG/JPEG/GIF/WebP. No ${...} templates: write the values into the text. Use it for summaries, receipts and records; buttons only work " +
    "in a workflow's ask-me-first step (human-input card).",
  parameters: {
    type: "object",
    properties: {
      heading: HEADING,
      card: { type: "object", description: "The Adaptive Card JSON" },
      fallback_text: FALLBACK_TEXT,
    },
    required: ["card"],
  },
  run: async ({ args }) =>
    finish(compact({ $ui: "adaptive_card", version: VERSION, title: args.heading, fallback_text: args.fallback_text, card: args.card })),
};

export const uiOperations = [adaptiveCardOperation, chartOperation, tableOperation, statsOperation];

function countWord(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The text an agent's model reads after a tool call: what the person now sees, without the data again.
 *
 * @param block - A validated UI block (object)
 * @returns One sentence (string)
 */
export function summarizeForModel(block) {
  const titled = block.title ? ` "${block.title}"` : "";
  const shown = {
    chart: () => `${block.type} chart${titled} with ${countWord(block.series.length, "series", "series")} over ${countWord(block.x.values.length, "category", "categories")}`,
    table: () => `table${titled} with ${countWord(block.rows.length, "row")} and ${countWord(block.columns.length, "column")}`,
    stats: () => `${countWord(block.items.length, "KPI tile")}${titled}`,
    adaptive_card: () => `Adaptive Card${titled}`,
  }[block.$ui]();
  return `Shown to the user: ${shown}. They can see it, so do not repeat its contents; add only your conclusions.`;
}
