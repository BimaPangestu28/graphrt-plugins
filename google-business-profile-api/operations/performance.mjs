/**
 * Performance (Business Profile Performance API v1): daily metrics such as
 * impressions, calls, website clicks and direction requests.
 */
import { rejectInput } from "../lib/client.mjs";
import { formatDate, parseDate } from "../lib/date-time.mjs";
import { LOCATION_ID_PROPERTY, v1LocationPath } from "../lib/resource-names.mjs";

export const DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "MESSAGING_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_MENU_CLICKS",
];

/**
 * Builds the fetchMultiDailyMetricsTimeSeries path; dailyMetrics repeats (the shared client would join arrays with commas).
 *
 * @param args - get_daily_metrics arguments (object)
 * @returns API path with query string (string)
 * @throws PluginError kind `invalid_input` - When dates are malformed or reversed
 */
export function buildDailyMetricsPath(args) {
  if (args.metrics.length === 0) rejectInput("`metrics` must contain at least one metric");
  const startDate = parseDate(args.start_date, "start_date");
  const endDate = parseDate(args.end_date, "end_date");
  if (args.start_date > args.end_date) rejectInput("`start_date` must not be after `end_date`");
  const queryEntries = [
    ...[...new Set(args.metrics)].map((metric) => ["dailyMetrics", metric]),
    ["dailyRange.start_date.year", startDate.year],
    ["dailyRange.start_date.month", startDate.month],
    ["dailyRange.start_date.day", startDate.day],
    ["dailyRange.end_date.year", endDate.year],
    ["dailyRange.end_date.month", endDate.month],
    ["dailyRange.end_date.day", endDate.day],
  ];
  return `${v1LocationPath(args.location_id)}:fetchMultiDailyMetricsTimeSeries?${new URLSearchParams(queryEntries.map(([name, value]) => [name, String(value)]))}`;
}

/**
 * Flattens the API's nested time series into `{metric, total, values: [{date, value}]}` per metric.
 * The API omits `value` on days with zero, so a missing value counts as 0.
 *
 * @param responseBody - fetchMultiDailyMetricsTimeSeries response (object)
 * @returns Metric series (Array<object>)
 */
export function flattenDailyMetrics(responseBody) {
  const series = (responseBody?.multiDailyMetricTimeSeries ?? []).flatMap((group) => group?.dailyMetricTimeSeries ?? []);
  return series.map((metricSeries) => {
    const values = (metricSeries?.timeSeries?.datedValues ?? []).map((datedValue) => ({
      date: formatDate(datedValue.date),
      value: Number(datedValue.value ?? 0),
    }));
    const total = values.reduce((sum, datedValue) => sum + datedValue.value, 0);
    return { metric: metricSeries?.dailyMetric ?? null, sub_entity_type: metricSeries?.dailySubEntityType ?? null, total, values };
  });
}

export const performanceOperations = [
  {
    name: "get_daily_metrics",
    title: "Get Google Business Profile daily metrics",
    description: "Daily performance of a location between two dates: impressions (Maps/Search, desktop/mobile), calls, website clicks, directions, messages, bookings.",
    parameters: {
      type: "object",
      properties: {
        location_id: LOCATION_ID_PROPERTY,
        start_date: { type: "string", description: "First day, YYYY-MM-DD" },
        end_date: { type: "string", description: "Last day, YYYY-MM-DD (inclusive)" },
        metrics: { type: "array", items: { type: "string", enum: DAILY_METRICS }, default: DAILY_METRICS, description: "Metrics to fetch; default all" },
      },
      required: ["location_id", "start_date", "end_date"],
    },
    run: async ({ client, args, signal }) => {
      for (const metric of args.metrics) if (!DAILY_METRICS.includes(metric)) rejectInput(`Unknown metric ${JSON.stringify(metric)}; use ${DAILY_METRICS.join(", ")}`);
      const responseBody = await client.performance.request({ path: buildDailyMetricsPath(args), signal });
      return { data: { location_id: args.location_id, start_date: args.start_date, end_date: args.end_date, metrics: flattenDailyMetrics(responseBody) } };
    },
  },
];
