/**
 * Async jobs for declarative REST operations.
 *
 * The create request is the write (rest-plugin.mjs sends it). This module reads the job id, polls the status
 * (a `path` template, or a URL the create response gives at `urlPath`), optionally fetches the result
 * (`job.result`), and returns `{job_id, status, result}`. Everything runs against one absolute deadline that
 * started with the call. URLs from responses must be https on the API's own host or a host in `job.allowedHosts`.
 */
import { PluginError } from "./graphrt-plugin.mjs";
import { readPath } from "./object-path.mjs";
import { pollUntilDone, resolvePollInterval } from "./polling.mjs";
import { fillPathTemplate } from "./rest-request.mjs";

export const DEFAULT_JOB_INTERVAL_MS = 2000;
const JOB_TIMEOUT_OVERRIDE_ENV = "GRAPHRT_JOB_TIMEOUT_MS";

/**
 * Reads the job id from the create response.
 *
 * @param job - `job` spec (object)
 * @param createBody - Create response body (object)
 * @returns Job id (string)
 * @throws PluginError kind `api_error` (not retryable) - No id at idPath
 */
export function readJobId(job, createBody) {
  const jobId = readPath(createBody, job.idPath);
  if (jobId === undefined || jobId === null || jobId === "") {
    throw new PluginError(`The API accepted the request but returned no job id at \`${job.idPath}\`; a job may have started, check before retrying`, {
      kind: "api_error",
      retryable: false,
    });
  }
  return String(jobId);
}

/**
 * The job's time budget: GRAPHRT_JOB_TIMEOUT_MS (tests), else job.timeoutMs, else the cap; never above the cap.
 *
 * @param job - `job` spec (object)
 * @param environment - Environment variables (object)
 * @param budgetCapMs - limits.timeout_ms minus the job margin (number)
 * @returns Budget in milliseconds, counted from the start of the call (number)
 */
export function resolveJobBudgetMs(job, environment, budgetCapMs) {
  const overrideMs = Number(environment?.[JOB_TIMEOUT_OVERRIDE_ENV]);
  const configuredMs = Number.isFinite(overrideMs) && overrideMs > 0 ? overrideMs : job.timeoutMs ?? budgetCapMs;
  return Math.max(1, Math.min(configuredMs, budgetCapMs));
}

/**
 * Polls until the job finishes and fetches its result.
 *
 * @param context - Job context (object)
 * @param context.operation - Normalized operation spec with `job` (object)
 * @param context.client - The operation's client, with `clientFor(baseUrl)` and `baseUrl` (object)
 * @param context.args - Validated arguments (object)
 * @param context.jobId - Job id from readJobId (string)
 * @param context.createBody - Create response body, redacted (object)
 * @param context.environment - Environment variables (object)
 * @param context.signal - Cancellation signal (AbortSignal, optional)
 * @param context.deadlineAt - Absolute deadline, ms since epoch (number)
 * @param context.jobLinks - Object the caller reads after a failure; `status` and `result` URLs are recorded here (object)
 * @returns `{job_id, status, result}` (Promise<object>)
 * @throws PluginError kinds `api_error` (failed, or a URL on a host that is not allowed), `timeout`, `cancelled`
 */
export async function waitForJob(context) {
  const { operation, jobId, createBody, environment, signal, deadlineAt, jobLinks } = context;
  const job = operation.job;
  const pollTarget = resolveJobRequest(job.poll, context);
  jobLinks.status = pollTarget.description;
  const remainingMs = Math.max(1, deadlineAt - Date.now());
  const statusBody = await pollUntilDone({
    readStatus: () => pollTarget.client.request({ ...pollTarget.request, signal, redactResponse: true }),
    isDone: (statusResult) => job.doneValues.includes(readPath(statusResult, job.statusPath)),
    isFailed: (statusResult) => describeFailure(job, statusResult),
    intervalMs: resolvePollInterval(environment, job.intervalMs ?? DEFAULT_JOB_INTERVAL_MS),
    timeoutMs: remainingMs,
    signal,
  }).catch((pollError) => {
    throw describePollError(pollError, jobId, pollTarget.description, remainingMs);
  });
  const resultBody = job.result ? await fetchJobResult(context, createBody) : statusBody;
  return { job_id: jobId, status: readPath(statusBody, job.statusPath), result: readPath(resultBody, job.resultPath) ?? null };
}

async function fetchJobResult(context, createBody) {
  const resultTarget = resolveJobRequest(context.operation.job.result, { ...context, createBody });
  context.jobLinks.result = resultTarget.description;
  const remainingMs = Math.max(1, context.deadlineAt - Date.now());
  return resultTarget.client.request({ ...resultTarget.request, signal: context.signal, redactResponse: true, timeoutMs: Math.min(remainingMs, 30000) });
}

/**
 * Resolves a poll or result request: a path template (with {id} and path params) or a URL from the create response.
 *
 * @param jobRequest - `job.poll` or `job.result` spec (object)
 * @param context - `{operation, client, args, jobId, createBody}` (object)
 * @returns `{client, request, description}` (object)
 * @throws PluginError kind `api_error` (not retryable) - Missing URL, or a URL that is not https on an allowed host
 */
export function resolveJobRequest(jobRequest, { operation, client, args, jobId, createBody }) {
  const method = (jobRequest.method ?? "GET").toUpperCase();
  const pollParams = Object.fromEntries(Object.entries(jobRequest.params ?? {}).map(([paramName, paramValue]) => [paramName, paramValue === "{id}" ? jobId : paramValue]));
  const isReadMethod = method === "GET" || method === "HEAD";
  const payload = isReadMethod ? { query: pollParams } : { json: pollParams };
  if (jobRequest.path) {
    const path = fillPathTemplate(jobRequest.path, { ...args, id: jobId });
    return { client, request: { method, path, idempotent: true, ...payload }, description: `${method} ${path}` };
  }
  const jobUrl = checkJobUrl(readPath(createBody, jobRequest.urlPath), operation.job, client.baseUrl, jobRequest.urlPath);
  const urlClient = client.clientFor(jobUrl.origin);
  return { client: urlClient, request: { method, path: jobUrl.href, idempotent: true, ...payload }, description: `${method} ${jobUrl.href}` };
}

function checkJobUrl(urlValue, job, baseUrl, urlPath) {
  const refuse = (problem) => {
    throw new PluginError(`The API's ${urlPath} ${problem}`, { kind: "api_error", retryable: false });
  };
  if (typeof urlValue !== "string") refuse("is missing from the create response");
  let jobUrl;
  try {
    jobUrl = new URL(urlValue);
  } catch {
    refuse(`is not a URL: ${JSON.stringify(urlValue)}`);
  }
  const allowedHosts = new Set([new URL(baseUrl).host, ...(job.allowedHosts ?? [])].map((host) => host.toLowerCase()));
  if (jobUrl.protocol !== "https:" || !allowedHosts.has(jobUrl.host.toLowerCase()) || jobUrl.username || jobUrl.password) {
    refuse(`${jobUrl.origin} is not https on an allowed host (${[...allowedHosts].join(", ")})`);
  }
  return jobUrl;
}

function describeFailure(job, statusResult) {
  const status = readPath(statusResult, job.statusPath);
  if (!(job.failedValues ?? []).includes(status)) return false;
  const reason = job.errorPath ? readPath(statusResult, job.errorPath) : undefined;
  if (typeof reason === "string" && reason !== "") return reason;
  return reason ? JSON.stringify(reason).slice(0, 500) : `status ${JSON.stringify(status)}`;
}

function describePollError(pollError, jobId, statusDescription, timeoutMs) {
  if (!(pollError instanceof PluginError)) return pollError;
  if (pollError.kind === "timeout") {
    const message = `Job ${jobId} is still running after ${Math.round(timeoutMs / 1000)} s; check it (api_request ${statusDescription}) before retrying, a retry starts a new job`;
    return new PluginError(message, { kind: "timeout", retryable: false });
  }
  if (pollError.kind === "api_error" && pollError.message.startsWith("Processing failed")) {
    return new PluginError(`Job ${jobId} failed: ${pollError.message.replace(/^Processing failed: /, "")}`, { kind: "api_error", retryable: false });
  }
  return pollError;
}

/**
 * Wraps any failure after the job was created: names the job and its known URLs and makes it not retryable,
 * because a retry would start (and pay for) a second job. The kind is kept (e.g. `cancelled`).
 *
 * @param jobError - Error thrown after create (any)
 * @param jobId - Job id (string)
 * @param jobLinks - `{status?, result?, files?}` known so far (object)
 * @returns PluginError (PluginError)
 */
export function describeJobError(jobError, jobId, jobLinks) {
  const message = String(jobError?.message ?? jobError);
  const linkNotes = [jobLinks.status && `status: ${jobLinks.status}`, jobLinks.result && `result: ${jobLinks.result}`, jobLinks.files?.length && `result URLs: ${jobLinks.files.join(", ")}`].filter(Boolean);
  const prefixedMessage = message.includes(jobId) ? message : `Job ${jobId}: ${message}`;
  const fullMessage = linkNotes.length > 0 ? `${prefixedMessage} (${linkNotes.join("; ")})` : prefixedMessage;
  return new PluginError(fullMessage, { kind: jobError?.kind ?? "api_error", retryable: false });
}
