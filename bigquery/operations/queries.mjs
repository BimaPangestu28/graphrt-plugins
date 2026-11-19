/**
 * Query operations: `query` (jobs.insert with our own job id, then getQueryResults; optional free dry run) and
 * `get_query_results` (pages and waits).
 *
 * Cost and safety:
 *   - every query carries maximumBytesBilled: the call's `maximum_bytes_billed`, which may not exceed
 *     BIGQUERY_MAX_BYTES_BILLED (default 1 GiB); BigQuery itself then refuses a query that would bill more.
 *   - agent tool calls first run a dry run (jobs.insert with dryRun, free) and are refused unless the statement
 *     type is SELECT (DML, DDL, scripts, EXPORT/LOAD...) — unless BIGQUERY_TOOL_ALLOW_WRITES=1 — and when the dry run
 *     already shows more bytes than the cap.
 *   - the job id is chosen here, so a retried insert cannot start a second job (409 means it exists), and an
 *     aborted call cancels its job in the background (jobs.cancel).
 *   - agent tools may only read results of jobs an agent tool call started in this process.
 */
import { randomUUID } from "node:crypto";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { pathSegment } from "../lib/shared/path.mjs";
import { buildQueryParameters } from "../lib/query-parameters.mjs";
import { decodeResultsCursor, shapeQueryResults } from "../lib/query-results.mjs";
import { summarizeSchema } from "../lib/row-decoding.mjs";
import { checkLocation, MAX_BYTES_BILLED_VARIABLE, pickProjectId, TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";
import { assertToolOwnsJob, rememberToolJob } from "../lib/tool-jobs.mjs";
import { PROJECT_PROPERTY } from "./catalog.mjs";

const MAX_PAGE_ROWS = 10000;
const REQUEST_MARGIN_MS = 15000;
const DEFAULT_DATASET_PATTERN = /^(?:([a-z0-9.:-]+)\.)?([A-Za-z0-9_]{1,1024})$/;
const RESULT_PROPERTIES = {
  max_rows: { type: "integer", minimum: 1, maximum: MAX_PAGE_ROWS, default: 1000, description: "Maximum rows in this page (also capped by BIGQUERY_MAX_RESULT_BYTES)" },
  wait_ms: { type: "integer", minimum: 1000, maximum: 90000, description: "How long to wait for the query to finish (default BIGQUERY_QUERY_TIMEOUT_MS)" },
};

function resolveBytesCap(args, settings) {
  if (args.maximum_bytes_billed === undefined) return settings.maxBytesBilled;
  if (args.maximum_bytes_billed > settings.maxBytesBilled) {
    throw new PluginError(`\`maximum_bytes_billed\` ${args.maximum_bytes_billed} is above ${MAX_BYTES_BILLED_VARIABLE} (${settings.maxBytesBilled})`, { kind: "invalid_input" });
  }
  return args.maximum_bytes_billed;
}

function parseDefaultDataset(defaultDataset, projectId) {
  if (defaultDataset === undefined) return undefined;
  const match = DEFAULT_DATASET_PATTERN.exec(defaultDataset);
  if (!match) throw new PluginError("`default_dataset` must be dataset or project.dataset", { kind: "invalid_input" });
  return { projectId: match[1] ?? projectId, datasetId: match[2] };
}

function buildQueryConfiguration(args, { projectId, bytesCap }) {
  return {
    query: args.sql,
    useLegacySql: false,
    maximumBytesBilled: String(bytesCap),
    useQueryCache: args.use_query_cache,
    defaultDataset: parseDefaultDataset(args.default_dataset, projectId),
    ...buildQueryParameters(normalizeParams(args.params)),
  };
}

// The schema caps wait_ms (timeout_ms is reserved by graphrt on nodes) at 90 s, so the request (wait + margin) always ends before the host's 120 s timeout.
function waitMilliseconds(args, settings) {
  return args.wait_ms ?? settings.queryTimeoutMs;
}

// Templates deliver objects and arrays as JSON text.
function normalizeParams(params) {
  if (typeof params !== "string") return params;
  try {
    return JSON.parse(params);
  } catch {
    throw new PluginError("`params` must be an object, an array, or their JSON text", { kind: "invalid_input" });
  }
}

async function runDryRun(client, { projectId, location, configuration, signal }) {
  const body = { configuration: { dryRun: true, query: configuration }, jobReference: { projectId, location } };
  const job = await client.request({ method: "POST", path: `/projects/${pathSegment(projectId)}/jobs`, json: body, signal, idempotent: true });
  const queryStatistics = job.statistics?.query ?? {};
  return {
    statementType: queryStatistics.statementType ?? null,
    totalBytesProcessed: Number(job.statistics?.totalBytesProcessed ?? queryStatistics.totalBytesProcessed ?? 0),
    schema: queryStatistics.schema,
    referencedTables: queryStatistics.referencedTables ?? [],
  };
}

function assertToolMayRun(dryRun, bytesCap) {
  if (dryRun.statementType !== "SELECT") {
    throw new PluginError(`Agent tools may only run SELECT queries (this is ${dryRun.statementType ?? "an unknown statement type"}); set ${TOOL_WRITES_VARIABLE}=1 to allow DML/DDL, or use a workflow node`, { kind: "permission_denied" });
  }
  if (dryRun.totalBytesProcessed > bytesCap) {
    throw new PluginError(`The query would process ${dryRun.totalBytesProcessed} bytes, more than maximum_bytes_billed (${bytesCap}); narrow it or raise the limit`, { kind: "invalid_input" });
  }
}

function describeDryRun(dryRun, bytesCap) {
  return {
    dry_run: true,
    statement_type: dryRun.statementType,
    total_bytes_processed: dryRun.totalBytesProcessed,
    maximum_bytes_billed: bytesCap,
    within_limit: dryRun.totalBytesProcessed <= bytesCap,
    schema: summarizeSchema(dryRun.schema),
    referenced_tables: dryRun.referencedTables.map((table) => `${table.projectId}.${table.datasetId}.${table.tableId}`),
  };
}

// Our own job id is known before the insert, so a retried insert cannot start a second job (409 Already Exists)
// and an abandoned call can always cancel its job.
function createJobId() {
  return `graphrt_${randomUUID().replaceAll("-", "_")}`;
}

async function insertQueryJob(client, { projectId, jobId, location, configuration, labels, signal }) {
  const body = { jobReference: { projectId, jobId, location }, configuration: { query: configuration, labels } };
  try {
    const job = await client.request({ method: "POST", path: `/projects/${pathSegment(projectId)}/jobs`, json: body, signal, idempotent: true });
    return job.jobReference?.location ?? location;
  } catch (insertError) {
    if (insertError instanceof PluginError && /API error 409/.test(insertError.message)) return location;
    throw insertError;
  }
}

// Best effort: the call was abandoned, so the job should not keep running (and billing) on its own.
function cancelJobInBackground(client, { projectId, jobId, location }) {
  const path = `/projects/${pathSegment(projectId)}/jobs/${pathSegment(jobId)}/cancel`;
  client
    .request({ method: "POST", path, query: { location }, signal: AbortSignal.timeout(10000), idempotent: true })
    .catch((cancelError) => console.error(`[bigquery] cancelling job ${jobId} failed: ${cancelError.message}`));
}

async function readJobResults(client, job, { startIndex, maxRows, waitMs, signal }) {
  const query = { location: job.location, startIndex: startIndex || undefined, maxResults: maxRows, timeoutMs: waitMs, "formatOptions.useInt64Timestamp": true };
  const path = `/projects/${pathSegment(job.projectId)}/queries/${pathSegment(job.jobId)}`;
  const response = await client.request({ path, query, signal, timeoutMs: waitMs + REQUEST_MARGIN_MS });
  const jobReference = { projectId: job.projectId, jobId: job.jobId, location: response.jobReference?.location ?? job.location };
  return shapeQueryResults({ ...response, jobReference }, { startIndex, maxResultBytes: client.settings.maxResultBytes });
}

async function cancelOnAbort(client, job, signal, work) {
  try {
    return await work();
  } catch (workError) {
    if (signal?.aborted) cancelJobInBackground(client, job);
    throw workError;
  }
}

async function runQuery({ client, args, signal, source }) {
  const { settings } = client;
  const projectId = pickProjectId(args, settings);
  const location = args.location === undefined ? settings.location : checkLocation(args.location, "`location`");
  const bytesCap = resolveBytesCap(args, settings);
  const configuration = buildQueryConfiguration(args, { projectId, bytesCap });
  const needsDryRun = args.dry_run || (source === "tool" && !settings.allowToolWrites);
  if (needsDryRun) {
    const dryRun = await runDryRun(client, { projectId, location, configuration, signal });
    if (args.dry_run) return { data: describeDryRun(dryRun, bytesCap) };
    assertToolMayRun(dryRun, bytesCap);
  }
  const job = { projectId, jobId: createJobId(), location };
  if (source === "tool") rememberToolJob(projectId, job.jobId);
  return cancelOnAbort(client, job, signal, async () => {
    job.location = await insertQueryJob(client, { ...job, configuration, labels: args.labels, signal });
    return readJobResults(client, job, { startIndex: 0, maxRows: args.max_rows, waitMs: waitMilliseconds(args, settings), signal });
  });
}

async function getQueryResults({ client, args, signal, source }) {
  const position = decodeResultsCursor(args.cursor);
  assertToolOwnsJob(source, position.projectId, position.jobId);
  const job = { projectId: position.projectId, jobId: position.jobId, location: position.location };
  const waitMs = waitMilliseconds(args, client.settings);
  return cancelOnAbort(client, job, signal, () => readJobResults(client, job, { startIndex: position.startIndex, maxRows: args.max_rows, waitMs, signal }));
}

export const queryOperations = [
  {
    name: "query",
    title: "Run query",
    description: `Run one GoogleSQL query with @named or ? parameters; returns typed rows and next_cursor. Every query is capped by maximum_bytes_billed (at most ${MAX_BYTES_BILLED_VARIABLE}); dry_run estimates bytes for free. As an agent tool only SELECT runs unless ${TOOL_WRITES_VARIABLE}=1`,
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", minLength: 1, description: "GoogleSQL, e.g. SELECT name, total FROM shop.orders WHERE created >= @since LIMIT 100" },
        params: { description: "Named params as an object ({\"since\": \"2026-11-01\"}) or positional as an array; typed values as {\"type\": \"DATE\", \"value\": \"2026-11-01\"}" },
        dry_run: { type: "boolean", default: false, description: "Only validate and estimate bytes processed (free)" },
        maximum_bytes_billed: { type: "integer", minimum: 1, description: `Bytes-billed limit for this query (default and maximum ${MAX_BYTES_BILLED_VARIABLE})` },
        default_dataset: { type: "string", description: "Dataset for unqualified table names: dataset or project.dataset" },
        location: { type: "string", description: "Job location, e.g. US, EU, asia-southeast1 (default BIGQUERY_LOCATION)" },
        use_query_cache: { type: "boolean", default: true, description: "Use cached results when available (free)" },
        labels: { type: "object", description: "Job labels, e.g. {\"source\": \"graphrt\"}" },
        project_id: PROJECT_PROPERTY,
        ...RESULT_PROPERTIES,
      },
      required: ["sql"],
    },
    run: runQuery,
  },
  {
    name: "get_query_results",
    title: "Get query results",
    description: "Next page of a query's rows (or wait for a query that was still running), from a query's next_cursor",
    parameters: { type: "object", properties: { cursor: { type: "string", minLength: 1, description: "next_cursor from query or get_query_results" }, ...RESULT_PROPERTIES }, required: ["cursor"] },
    run: getQueryResults,
  },
];
