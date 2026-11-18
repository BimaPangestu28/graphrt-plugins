/**
 * Async jobs and generated-media downloads for declarative REST operations.
 *
 * A `job` operation's create request is the write; this module then polls the status endpoint with the shared
 * pollUntilDone (transient read errors are tolerated) and returns `{job_id, status, result}`. A timeout reports
 * the job id with `retryable: false`, because re-running the operation would start (and pay for) a second job.
 *
 * `download.saveTo` streams the result's URLs into the directory named by an env var, with the public-https checks
 * of public-https-fetch.mjs, and returns `saved_files` next to the remote URLs.
 */
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { PluginError } from "./graphrt-plugin.mjs";
import { collectPathValues, readPath } from "./object-path.mjs";
import { pollUntilDone, resolvePollInterval } from "./polling.mjs";
import { downloadPublicHttpsToFile } from "./public-https-fetch.mjs";
import { fillPathTemplate } from "./rest-request.mjs";

export const DEFAULT_JOB_INTERVAL_MS = 2000;
export const DEFAULT_JOB_TIMEOUT_MS = 300000;
const JOB_TIMEOUT_OVERRIDE_ENV = "GRAPHRT_JOB_TIMEOUT_MS";

/**
 * Reads the job id from the create response, polls until done and returns the result.
 *
 * @param context - Job context (object)
 * @param context.operation - Normalized operation spec with `job` (object)
 * @param context.client - Shared API client (object)
 * @param context.args - Validated arguments (object)
 * @param context.createBody - Body of the create response (object)
 * @param context.environment - Environment variables (object)
 * @param context.signal - Cancellation signal (AbortSignal, optional)
 * @param context.timeoutCapMs - Upper bound for the wait, so the error arrives before the host's timeout (number)
 * @returns `{job_id, status, result}`, or `{job_id, response}` when `wait` is false (Promise<object>)
 * @throws PluginError kinds `api_error` (no id, or the job failed; not retryable), `timeout` (not retryable), `cancelled`
 */
export async function runRestJob({ operation, client, args, createBody, environment, signal, timeoutCapMs }) {
  const job = operation.job;
  const jobId = readJobId(job, createBody);
  if (args.wait === false) return { job_id: jobId, response: createBody };
  const timeoutMs = resolveJobTimeout(environment, job, timeoutCapMs);
  const pollRequest = buildPollRequest(job, args, jobId);
  try {
    const statusBody = await pollUntilDone({
      readStatus: () => client.request({ ...pollRequest, signal }),
      isDone: (statusResult) => job.doneValues.includes(readPath(statusResult, job.statusPath)),
      isFailed: (statusResult) => describeFailure(job, statusResult),
      intervalMs: resolvePollInterval(environment, job.intervalMs ?? DEFAULT_JOB_INTERVAL_MS),
      timeoutMs,
      signal,
    });
    return { job_id: jobId, status: readPath(statusBody, job.statusPath), result: readPath(statusBody, job.resultPath) ?? null };
  } catch (pollError) {
    throw describeJobError(pollError, jobId, pollRequest.path, timeoutMs);
  }
}

function readJobId(job, createBody) {
  const jobId = readPath(createBody, job.idPath);
  if (jobId === undefined || jobId === null || jobId === "") {
    throw new PluginError(`The API accepted the request but returned no job id at \`${job.idPath}\`; a job may have started, check before retrying`, {
      kind: "api_error",
      retryable: false,
    });
  }
  return String(jobId);
}

function resolveJobTimeout(environment, job, timeoutCapMs) {
  const overrideMs = Number(environment?.[JOB_TIMEOUT_OVERRIDE_ENV]);
  const configuredMs = Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : job.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  return Math.max(1, Math.min(configuredMs, timeoutCapMs));
}

function buildPollRequest(job, args, jobId) {
  const method = (job.poll.method ?? "GET").toUpperCase();
  const path = fillPathTemplate(job.poll.path, { ...args, id: jobId });
  const pollParams = substituteJobId(job.poll.params ?? {}, jobId);
  const isReadMethod = method === "GET" || method === "HEAD";
  // A status read is safe to repeat, whatever its method.
  return { method, path, idempotent: true, ...(isReadMethod ? { query: pollParams } : { json: pollParams }) };
}

function substituteJobId(pollParams, jobId) {
  return Object.fromEntries(Object.entries(pollParams).map(([paramName, paramValue]) => [paramName, paramValue === "{id}" ? jobId : paramValue]));
}

function describeFailure(job, statusResult) {
  const status = readPath(statusResult, job.statusPath);
  if (!(job.failedValues ?? []).includes(status)) return false;
  const reason = job.errorPath ? readPath(statusResult, job.errorPath) : undefined;
  if (typeof reason === "string" && reason !== "") return reason;
  return reason ? JSON.stringify(reason).slice(0, 500) : `status ${JSON.stringify(status)}`;
}

function describeJobError(pollError, jobId, pollPath, timeoutMs) {
  if (!(pollError instanceof PluginError)) return pollError;
  if (pollError.kind === "timeout") {
    const message = `Job ${jobId} is still running after ${Math.round(timeoutMs / 1000)} s; check it (api_request GET ${pollPath}) before retrying, a retry starts a new job`;
    return new PluginError(message, { kind: "timeout", retryable: false });
  }
  if (pollError.kind === "api_error" && pollError.message.startsWith("Processing failed")) {
    return new PluginError(`Job ${jobId} failed: ${pollError.message.replace(/^Processing failed: /, "")}`, { kind: "api_error", retryable: false });
  }
  return pollError;
}

/**
 * Downloads every https URL found at `saveTo.urlPaths` in the result into `$<envDir>`. A URL that cannot be saved
 * gets an `error` entry instead, so a paid result is never lost to one failed download.
 *
 * @param context - Download context (object)
 * @param context.operation - Normalized operation spec with `download` (object)
 * @param context.result - Operation result to search for URLs (any)
 * @param context.client - Client with `fetchImpl` and `resolveHostAddresses` (object)
 * @param context.environment - Environment variables (object)
 * @param context.signal - Cancellation signal (AbortSignal, optional)
 * @returns `[{url, path, bytes, content_type} | {url, error}]`; empty when the env var is unset (Promise<Array>)
 * @throws PluginError kinds `invalid_input` (relative directory), `cancelled`
 */
export async function saveDownloads({ operation, result, client, environment, signal }) {
  const saveTo = operation.download.saveTo;
  const directory = environment?.[saveTo.envDir]?.trim();
  if (!directory) return [];
  if (!isAbsolute(directory)) throw new PluginError(`${saveTo.envDir} must be an absolute directory path`, { kind: "invalid_input" });
  const urls = [...new Set(saveTo.urlPaths.flatMap((urlPath) => collectPathValues(result, urlPath)).filter((url) => typeof url === "string"))];
  const batchName = `${operation.name}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const savedFiles = [];
  for (const [index, url] of urls.entries()) {
    savedFiles.push(await saveOneDownload(url, { directory, fileBaseName: `${batchName}-${index + 1}`, client, signal, maxBytes: saveTo.maxBytes }));
  }
  return savedFiles;
}

async function saveOneDownload(url, { directory, fileBaseName, client, signal, maxBytes }) {
  try {
    const downloadOptions = { directory, fileBaseName, fetchImpl: client.fetchImpl, resolveHostAddresses: client.resolveHostAddresses, signal, maxBytes, label: "result URL" };
    return await downloadPublicHttpsToFile(url, downloadOptions);
  } catch (downloadError) {
    if (downloadError?.kind === "cancelled") throw downloadError;
    return { url, error: String(downloadError?.message ?? downloadError) };
  }
}
