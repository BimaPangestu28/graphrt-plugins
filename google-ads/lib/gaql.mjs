/**
 * Google Ads Query Language (GAQL) helpers. GAQL only reads (changes go through the `:mutate` endpoints), but a
 * query is still checked before it is sent: it must start with SELECT and may not carry a PARAMETERS clause
 * (`include_drafts`, `omit_unselected_resource_names` change what is returned). The convenience reports build
 * their GAQL only from validated parts: allowlisted metric names, date literals or checked YYYY-MM-DD dates, and
 * numeric ids.
 *
 * Grammar: https://developers.google.com/google-ads/api/docs/query/grammar
 * Date literals: https://developers.google.com/google-ads/api/docs/query/date-ranges
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MAX_QUERY_LENGTH = 20000;
export const DATE_RANGES = ["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_BUSINESS_WEEK", "THIS_MONTH", "LAST_MONTH", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_WEEK_SUN_TODAY", "THIS_WEEK_MON_TODAY", "LAST_WEEK_SUN_SAT", "LAST_WEEK_MON_SUN"];
export const REPORT_METRICS = ["impressions", "clicks", "ctr", "average_cpc", "average_cpm", "cost_micros", "conversions", "conversions_value", "cost_per_conversion", "all_conversions", "interactions"];
export const DEFAULT_REPORT_METRICS = ["impressions", "clicks", "ctr", "average_cpc", "cost_micros", "conversions"];
const STRING_LITERALS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

const invalid = (message) => new PluginError(message, { kind: "invalid_input" });

/**
 * Checks that a GAQL query is a plain SELECT without a PARAMETERS clause.
 *
 * @param query - GAQL text (string)
 * @returns The trimmed query (string)
 * @throws PluginError kind `invalid_input` - Not a string, too long, not a SELECT, or with PARAMETERS
 *
 * @example
 * assertReadOnlyGaql("SELECT campaign.id FROM campaign"); // "SELECT campaign.id FROM campaign"
 */
export function assertReadOnlyGaql(query) {
  if (typeof query !== "string" || query.trim() === "") throw invalid("`query` must be a GAQL query, e.g. SELECT campaign.id, campaign.name FROM campaign");
  const trimmedQuery = query.trim();
  if (trimmedQuery.length > MAX_QUERY_LENGTH) throw invalid(`\`query\` is longer than ${MAX_QUERY_LENGTH} characters`);
  if (!/^select\s/i.test(trimmedQuery)) throw invalid("`query` must start with SELECT (GAQL is read-only; use the mutate operations for changes)");
  const queryWithoutLiterals = trimmedQuery.replace(STRING_LITERALS, "''");
  if (/\bparameters\b/i.test(queryWithoutLiterals)) throw invalid("`query` may not contain a PARAMETERS clause");
  return trimmedQuery;
}

/**
 * Checks a numeric Google Ads id (customer, campaign, ad group, budget, criterion).
 *
 * @param idValue - Id as given (string | number)
 * @param label - Argument name for messages (string)
 * @returns The id as digits (string)
 * @throws PluginError kind `invalid_input` - Not digits only
 */
export function assertNumericId(idValue, label) {
  const idText = String(idValue ?? "").trim();
  if (!/^\d{1,20}$/.test(idText)) throw invalid(`\`${label}\` must be a numeric id, got ${JSON.stringify(idValue ?? null)}`);
  return idText;
}

/**
 * Builds the `segments.date` condition from a date literal or a start/end date pair.
 *
 * @param range - `{date_range?, start_date?, end_date?}` (object)
 * @returns e.g. "segments.date DURING LAST_30_DAYS" or "segments.date BETWEEN '2026-11-01' AND '2026-11-18'" (string)
 * @throws PluginError kind `invalid_input` - Both forms, only one date, an invalid date, or start after end
 */
export function buildDateCondition({ date_range: dateRange, start_date: startDate, end_date: endDate }) {
  const hasDates = startDate !== undefined || endDate !== undefined;
  if (dateRange !== undefined && hasDates) throw invalid("give either `date_range` or `start_date` + `end_date`, not both");
  if (!hasDates) {
    const literal = dateRange ?? "LAST_30_DAYS";
    if (!DATE_RANGES.includes(literal)) throw invalid(`\`date_range\` must be one of ${DATE_RANGES.join(", ")}`);
    return `segments.date DURING ${literal}`;
  }
  const start = assertCalendarDate(startDate, "start_date");
  const end = assertCalendarDate(endDate, "end_date");
  if (start > end) throw invalid("`start_date` must not be after `end_date`");
  return `segments.date BETWEEN '${start}' AND '${end}'`;
}

function assertCalendarDate(dateValue, label) {
  const dateText = String(dateValue ?? "");
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateText) throw invalid(`\`${label}\` must be a date YYYY-MM-DD, got ${JSON.stringify(dateValue ?? null)}`);
  return dateText;
}

/**
 * Checks report metric names against the allowlist.
 *
 * @param metrics - Metric names without the `metrics.` prefix (string[], optional)
 * @returns Metric names, the defaults when omitted (string[])
 * @throws PluginError kind `invalid_input` - Empty list or a name not in REPORT_METRICS
 */
export function resolveReportMetrics(metrics) {
  if (metrics === undefined) return DEFAULT_REPORT_METRICS;
  if (!Array.isArray(metrics) || metrics.length === 0) throw invalid("`metrics` must be a non-empty list");
  const names = metrics.map((metric) => String(metric).trim().replace(/^metrics\./, ""));
  const unknown = names.filter((name) => !REPORT_METRICS.includes(name));
  if (unknown.length > 0) throw invalid(`unknown metrics ${unknown.join(", ")}; allowed: ${REPORT_METRICS.join(", ")}`);
  return [...new Set(names)];
}

/**
 * Assembles a report query.
 *
 * @param parts - Query parts (object)
 * @param parts.fields - Attribute fields to select (string[])
 * @param parts.metrics - Validated metric names (string[])
 * @param parts.resource - FROM resource, e.g. "campaign" (string)
 * @param parts.conditions - WHERE conditions, joined with AND (string[])
 * @param parts.limit - LIMIT (integer)
 * @returns GAQL text (string)
 */
export function buildReportQuery({ fields, metrics, resource, conditions, limit }) {
  const orderMetric = metrics.includes("cost_micros") ? "cost_micros" : metrics[0];
  const selectList = [...fields, ...metrics.map((metric) => `metrics.${metric}`)].join(", ");
  return `SELECT ${selectList} FROM ${resource} WHERE ${conditions.join(" AND ")} ORDER BY metrics.${orderMetric} DESC LIMIT ${limit}`;
}
