/**
 * google-analytics plugin definition: Google Analytics 4 reports through the Data API v1beta
 * (https://developers.google.com/analytics/devguides/reporting/data/v1/rest) and account/property discovery through
 * the Admin API v1beta (https://developers.google.com/analytics/devguides/config/admin/v1/rest). Built with the
 * declarative REST layer (docs/declarative-plugins.md); Google credentials come from the shared Google auth files
 * (lib/google-rest-auth.mjs), and report operations accept plain dimension/metric names (lib/report-fields.mjs).
 *
 * Agent policy: every operation is a read (the report methods are POSTs that only read, so they are
 * `idempotent`), and all are tools. The scope is analytics.readonly.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createGoogleAuth, createGoogleErrors, withGoogleCredentials } from "./lib/google-rest-auth.mjs";
import { replaceOperation, wrapBatchReportOperation, wrapReportOperation } from "./lib/report-fields.mjs";
import { wrapPropertyIdOperation } from "./lib/property-id.mjs";

const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const PROPERTY_ID = { in: "path", type: "string", required: true, description: "Numeric GA4 property id, e.g. 123456789 (from list_account_summaries: properties/<id>)" };
const objectList = (description, maxItems) => ({ in: "body", type: "array", items: { type: "object" }, description, ...(maxItems ? { maxItems } : {}) });
const reportFields = {
  dimensions: objectList("Dimensions", 9),
  metrics: objectList("Metrics", 10),
  dimension_filter: { in: "body", type: "object", wireName: "dimensionFilter", description: 'FilterExpression on dimensions, e.g. {"filter": {"fieldName": "country", "stringFilter": {"value": "Indonesia"}}}' },
  metric_filter: { in: "body", type: "object", wireName: "metricFilter", description: "FilterExpression on metric values (applied after aggregation)" },
};
const dateRanges = objectList('Date ranges, e.g. [{"startDate": "28daysAgo", "endDate": "yesterday"}] (YYYY-MM-DD, today, yesterday or NdaysAgo; up to 4; omit for cohort reports)', 4);
const sharedReportFields = {
  currency_code: { in: "body", type: "string", wireName: "currencyCode", description: "ISO 4217 code, e.g. IDR (default: the property's currency)" },
  cohort_spec: { in: "body", type: "object", wireName: "cohortSpec", description: "Cohort definition (needs the cohort dimension)" },
  keep_empty_rows: { in: "body", type: "boolean", wireName: "keepEmptyRows", description: "Keep rows whose metrics are all 0" },
  return_property_quota: { in: "body", type: "boolean", wireName: "returnPropertyQuota", description: "Include the property's remaining quota tokens" },
  comparisons: objectList("Comparisons (adds a comparison column)"),
};
const rowWindow = {
  limit: { in: "body", type: "integer", min: 1, max: 250000, description: "Rows to return (default 10000, max 250000)" },
  offset: { in: "body", type: "integer", min: 0, description: "First row to return (0-based); with rowCount for paging" },
};
const metricAggregations = { in: "body", type: "array", items: { type: "string" }, wireName: "metricAggregations", description: "Extra total rows: TOTAL, MINIMUM, MAXIMUM, COUNT" };
const orderBys = { ...objectList('Sort, e.g. [{"metric": {"metricName": "activeUsers"}, "desc": true}]'), wireName: "orderBys" };
const reportRead = (name, title, description, path, params) => ({ name, title, description, method: "POST", path, write: "idempotent", params: { property_id: PROPERTY_ID, ...params } });
const adminPage = (dataPath) => ({ dataPath, cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 200, defaultLimit: 50 });

const dataOperations = [
  reportRead("run_report", "Run report", "A GA4 report: dimensions x metrics over date ranges, with filters, sorting and totals", "/properties/{property_id}:runReport", {
    ...reportFields,
    metrics: { ...reportFields.metrics, required: true },
    date_ranges: { ...dateRanges, wireName: "dateRanges" },
    ...rowWindow,
    metric_aggregations: metricAggregations,
    order_bys: orderBys,
    ...sharedReportFields,
  }),
  reportRead("run_realtime_report", "Realtime report", "Events of the last 30 minutes (60 for Analytics 360), e.g. activeUsers by country", "/properties/{property_id}:runRealtimeReport", {
    ...reportFields,
    metrics: { ...reportFields.metrics, required: true },
    limit: rowWindow.limit,
    metric_aggregations: metricAggregations,
    order_bys: orderBys,
    return_property_quota: sharedReportFields.return_property_quota,
    minute_ranges: { ...objectList('Up to 2 minute ranges, e.g. [{"startMinutesAgo": 29, "endMinutesAgo": 0}] (default: the last 30 minutes)', 2), wireName: "minuteRanges" },
  }),
  reportRead("run_pivot_report", "Pivot report", "A pivot table report (pivots group dimensions into rows and columns)", "/properties/{property_id}:runPivotReport", {
    ...reportFields,
    date_ranges: { ...dateRanges, wireName: "dateRanges" },
    pivots: { ...objectList('Pivots, e.g. [{"fieldNames": ["country"], "limit": 10}]'), required: true },
    ...sharedReportFields,
  }),
  reportRead("batch_run_reports", "Batch reports", "Up to 5 runReport requests in one call (each item like run_report's body in API field names)", "/properties/{property_id}:batchRunReports", {
    requests: { ...objectList('Report requests, e.g. [{"dimensions": ["country"], "metrics": ["activeUsers"], "dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}]}]', 5), required: true },
  }),
  {
    name: "get_metadata",
    title: "Dimensions and metrics",
    description: "Every dimension and metric a property supports, with custom ones (property_id 0: only the common ones)",
    path: "/properties/{property_id}/metadata",
    params: { property_id: PROPERTY_ID },
  },
  reportRead("check_compatibility", "Check compatibility", "Which dimensions and metrics can be combined with the given ones in run_report", "/properties/{property_id}:checkCompatibility", {
    ...reportFields,
    compatibility_filter: { in: "body", type: "string", enum: ["COMPATIBLE", "INCOMPATIBLE"], wireName: "compatibilityFilter", description: "Only return compatible or incompatible fields" },
  }),
];

const adminOperations = [
  { name: "list_account_summaries", title: "Accounts and properties", description: "Every account the caller can access with its properties (ids and names)", baseUrl: ADMIN_API, path: "/accountSummaries", response: adminPage("accountSummaries") },
  {
    name: "list_properties",
    title: "List properties",
    description: "Properties under an account",
    baseUrl: ADMIN_API,
    path: "/properties",
    params: {
      filter: { in: "query", type: "string", required: true, description: "parent:accounts/<id>, ancestor:accounts/<id> or firebase_project:<id>" },
      show_deleted: { in: "query", type: "boolean", wireName: "showDeleted", description: "Include properties in the trash" },
    },
    response: adminPage("properties"),
  },
  { name: "get_property", title: "Get property", description: "A property's name, time zone, currency, industry and service level", baseUrl: ADMIN_API, path: "/properties/{property_id}", params: { property_id: PROPERTY_ID } },
  { name: "list_data_streams", title: "List data streams", description: "Web and app data streams of a property (measurement ids, app ids)", baseUrl: ADMIN_API, path: "/properties/{property_id}/dataStreams", params: { property_id: PROPERTY_ID }, response: adminPage("dataStreams") },
];

const restDefinition = defineRestPlugin({
  name: "google-analytics",
  version: "0.1.0",
  description: "Google Analytics 4: run reports, realtime, pivot and batch reports, metadata and compatibility checks, and list accounts, properties and data streams (read-only; OAuth or service account)",
  apiName: "Google Analytics Data API",
  baseUrl: "https://analyticsdata.googleapis.com/v1beta",
  auth: createGoogleAuth("https://www.googleapis.com/auth/analytics.readonly"),
  errors: createGoogleErrors("error.status"),
  apiRequest: { examplePath: "/properties/<id>/metadata" },
  operations: [...dataOperations, ...adminOperations],
});

export const reportDefinition = [
  ["run_report", wrapReportOperation],
  ["run_realtime_report", wrapReportOperation],
  ["run_pivot_report", wrapReportOperation],
  ["check_compatibility", wrapReportOperation],
  ["batch_run_reports", wrapBatchReportOperation],
].reduce((definition, [operationName, wrap]) => replaceOperation(definition, operationName, wrap), withGoogleCredentials(restDefinition));
// property_id may be 123456789 or properties/123456789 (lib/property-id.mjs); anything else is refused.
export const pluginDefinition = { ...reportDefinition, operations: reportDefinition.operations.map(wrapPropertyIdOperation) };
