import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser } from "../lib/shared/rest-errors.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { pluginDefinition, reportDefinition } from "../definition.mjs";

const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";
const PROPERTY = "123456789";
const LAST_WEEK = [{ startDate: "7daysAgo", endDate: "today" }];

// The generated traversal probe expects "../../escape" to be sent as one encoded segment; the property-id check
// refuses it before any request (tested in property-id.test.mjs), so the contract runs without that wrapper.
describeRestPluginContract(reportDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    run_report: {
      args: { property_id: PROPERTY, dimensions: ["country"], metrics: ["activeUsers", { name: "sessions" }], date_ranges: LAST_WEEK, limit: 10, order_bys: [{ metric: { metricName: "activeUsers" }, desc: true }], metric_aggregations: ["TOTAL"] },
      request: {
        method: "POST",
        url: `${DATA_API}/properties/${PROPERTY}:runReport`,
        query: "absent",
        json: {
          dimensions: [{ name: "country" }],
          metrics: [{ name: "activeUsers" }, { name: "sessions" }],
          dateRanges: LAST_WEEK,
          limit: 10,
          orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
          metricAggregations: ["TOTAL"],
        },
      },
      response: { body: { rows: [{ dimensionValues: [{ value: "Indonesia" }], metricValues: [{ value: "42" }, { value: "50" }] }], rowCount: 1 } },
      expect: { data: { rows: [{ dimensionValues: [{ value: "Indonesia" }], metricValues: [{ value: "42" }, { value: "50" }] }], rowCount: 1 } },
    },
    run_realtime_report: {
      args: { property_id: PROPERTY, dimensions: ["unifiedScreenName"], metrics: ["activeUsers"], minute_ranges: [{ startMinutesAgo: 5, endMinutesAgo: 0 }] },
      request: {
        method: "POST",
        url: `${DATA_API}/properties/${PROPERTY}:runRealtimeReport`,
        query: "absent",
        json: { dimensions: [{ name: "unifiedScreenName" }], metrics: [{ name: "activeUsers" }], minuteRanges: [{ startMinutesAgo: 5, endMinutesAgo: 0 }] },
      },
    },
    run_pivot_report: {
      args: { property_id: PROPERTY, dimensions: ["country", "deviceCategory"], metrics: ["sessions"], date_ranges: LAST_WEEK, pivots: [{ fieldNames: ["country"], limit: 5 }, { fieldNames: ["deviceCategory"], limit: 3 }] },
      request: {
        method: "POST",
        url: `${DATA_API}/properties/${PROPERTY}:runPivotReport`,
        query: "absent",
        json: { dimensions: [{ name: "country" }, { name: "deviceCategory" }], metrics: [{ name: "sessions" }], dateRanges: LAST_WEEK, pivots: [{ fieldNames: ["country"], limit: 5 }, { fieldNames: ["deviceCategory"], limit: 3 }] },
      },
    },
    batch_run_reports: {
      args: { property_id: PROPERTY, requests: [{ dimensions: ["date"], metrics: ["activeUsers"], dateRanges: LAST_WEEK }, { metrics: [{ name: "sessions" }], dateRanges: LAST_WEEK }] },
      request: {
        method: "POST",
        url: `${DATA_API}/properties/${PROPERTY}:batchRunReports`,
        query: "absent",
        json: { requests: [{ dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }], dateRanges: LAST_WEEK }, { metrics: [{ name: "sessions" }], dateRanges: LAST_WEEK }] },
      },
    },
    get_metadata: { args: { property_id: "0" }, request: { method: "GET", url: `${DATA_API}/properties/0/metadata`, query: "absent" }, response: { body: { name: "properties/0/metadata", dimensions: [{ apiName: "country" }] } } },
    check_compatibility: {
      args: { property_id: PROPERTY, dimensions: ["country"], metrics: ["activeUsers"], compatibility_filter: "INCOMPATIBLE" },
      request: { method: "POST", url: `${DATA_API}/properties/${PROPERTY}:checkCompatibility`, query: "absent", json: { dimensions: [{ name: "country" }], metrics: [{ name: "activeUsers" }], compatibilityFilter: "INCOMPATIBLE" } },
    },
    list_account_summaries: {
      args: { limit: 20 },
      request: { method: "GET", url: `${ADMIN_API}/accountSummaries`, query: { pageSize: "20" } },
      response: { body: { accountSummaries: [{ account: "accounts/1", propertySummaries: [{ property: "properties/123456789" }] }], nextPageToken: "n2" } },
      expect: { data: [{ account: "accounts/1", propertySummaries: [{ property: "properties/123456789" }] }] },
    },
    list_properties: {
      args: { filter: "parent:accounts/1", show_deleted: true },
      request: { method: "GET", url: `${ADMIN_API}/properties`, query: { filter: "parent:accounts/1", showDeleted: "true", pageSize: "50" } },
      response: { body: { properties: [{ name: "properties/123456789" }] } },
      expect: { data: [{ name: "properties/123456789" }] },
    },
    get_property: { args: { property_id: PROPERTY }, request: { method: "GET", url: `${ADMIN_API}/properties/${PROPERTY}`, query: "absent" } },
    list_data_streams: {
      args: { property_id: PROPERTY },
      request: { method: "GET", url: `${ADMIN_API}/properties/${PROPERTY}/dataStreams`, query: { pageSize: "50" } },
      response: { body: { dataStreams: [{ type: "WEB_DATA_STREAM", webStreamData: { measurementId: "G-ABC" } }] } },
      expect: { data: [{ type: "WEB_DATA_STREAM", webStreamData: { measurementId: "G-ABC" } }] },
    },
  },
});

afterEach(() => clearCachedAccessTokens());

async function runAnalytics(operationName, args, { source = "tool", responses = [{ body: { rows: [] } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "ya29.analytics-token-1" }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("every operation is a tool (read-only plugin) and only Google credentials are env", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.equal(manifest.tools.length, pluginDefinition.operations.length);
  assert.deepEqual(manifest.permissions.env.sort(), ["GOOGLE_ACCESS_TOKEN", "GOOGLE_ANALYTICS_TOOL_TOKEN_SOURCE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON"]);
  const runReportTool = manifest.tools.find((tool) => tool.name === "run_report");
  assert.deepEqual(runReportTool.parameters.required, ["property_id", "metrics"]);
  assert.equal(runReportTool.parameters.properties.metrics.items, undefined, "names and objects are both accepted");
});

test("report POSTs are reads: retried after a 5xx", async () => {
  const { error, calls } = await runAnalytics("run_report", { property_id: PROPERTY, metrics: ["activeUsers"], date_ranges: LAST_WEEK }, { responses: [{ status: 503, body: { error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } } }, { body: { rows: [] } }] });
  if (error) throw error;
  assert.equal(calls.length, 2);
});

test("invalid dimension or metric names are refused before any request", async () => {
  for (const args of [{ property_id: PROPERTY, metrics: [""] }, { property_id: PROPERTY, metrics: ["activeUsers"], dimensions: [42] }, { property_id: PROPERTY, requests: ["not a request"] }]) {
    const operationName = args.requests ? "batch_run_reports" : "run_report";
    const { error, calls } = await runAnalytics(operationName, args);
    assert.equal(error?.kind, "invalid_input", JSON.stringify(args));
    assert.equal(calls.length, 0);
  }
});

test("batch_run_reports allows at most 5 requests", async () => {
  const request = { metrics: ["activeUsers"], dateRanges: LAST_WEEK };
  const { error, calls } = await runAnalytics("batch_run_reports", { property_id: PROPERTY, requests: Array(6).fill(request) });
  assert.equal(error?.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("GA errors map by error.status (quota exhaustion is rate_limited)", () => {
  const parseDeclared = createErrorParser(pluginDefinition.restSpec.errors);
  const cases = [
    [403, "permission_denied", { error: { code: 403, message: "User does not have sufficient permissions for this property.", status: "PERMISSION_DENIED" } }],
    [429, "rate_limited", { error: { code: 429, message: "Exhausted property tokens per hour.", status: "RESOURCE_EXHAUSTED" } }],
    [400, "invalid_input", { error: { code: 400, message: "Field foo is not a valid dimension.", status: "INVALID_ARGUMENT" } }],
    [401, "auth_error", { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }],
  ];
  for (const [status, kind, body] of cases) assert.equal(parseDeclared(status, body).kind, kind, body.error.message);
});
