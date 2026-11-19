/**
 * `run_model` for fal-ai: the declarative submit plus a fal-specific wait.
 *
 * fal reports a failed request as status COMPLETED with `error` and `error_type` set, so the layer's job settings
 * (done = COMPLETED) cannot tell success from failure. This operation submits through the declarative operation
 * with `wait: false` (so the write keeps the layer's request, retry and unknown-outcome rules), then polls
 * `status_url` itself with the shared polling helper: COMPLETED without `error` is done, COMPLETED with `error`
 * is a non-retryable failure with fal's message. On success it fetches `response_url` and saves media from the
 * allowed delivery hosts only. Status and result URLs are checked by the layer's `resolveJobRequest` (https on
 * queue.fal.run, the only host the key is sent to), and everything runs against the layer's job deadline.
 */
import { pollUntilDone, resolvePollInterval } from "./shared/polling.mjs";
import { describeJobError, DEFAULT_JOB_INTERVAL_MS, resolveJobBudgetMs, resolveJobRequest } from "./shared/rest-job.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";
import { describeTimeBudgets } from "./shared/rest-spec-helpers.mjs";
import { saveAllowedDownloads } from "./restricted-downloads.mjs";

const COMPLETED = "COMPLETED";
const RESULT_FETCH_TIMEOUT_MS = 30000;

/**
 * Builds the run_model operation around the generated (declarative) one.
 *
 * @param options - Settings (object)
 * @param options.submitOperation - Generated run_model operation (object with run)
 * @param options.restOperation - Normalized run_model spec with `job` and `download` (object)
 * @param options.limits - Plugin limits (object)
 * @param options.resolveAllowedHosts - `(environment) => {hostSuffixes, extraHosts}` (function)
 * @returns Operation with the generated name, schema and description (object)
 */
export function createRunModelOperation({ submitOperation, restOperation, limits, resolveAllowedHosts }) {
  const jobBudgetCapMs = describeTimeBudgets(limits).jobBudgetCapMs;
  return {
    ...submitOperation,
    run: async (context) => {
      const startedAt = Date.now();
      const submitted = await submitOperation.run({ ...context, source: "node", args: { ...context.args, wait: false } });
      if (context.args.wait === false) return finishOutput(submitted.data, context.source);
      const deadlineAt = startedAt + resolveJobBudgetMs(restOperation.job, context.environment, jobBudgetCapMs);
      const data = await waitAndCollect({ restOperation, context, jobId: submitted.data.job_id, createBody: submitted.data.response, deadlineAt, resolveAllowedHosts });
      return finishOutput(data, context.source);
    },
  };
}

async function waitAndCollect({ restOperation, context, jobId, createBody, deadlineAt, resolveAllowedHosts }) {
  const jobLinks = {};
  const jobContext = { operation: restOperation, client: context.client, args: context.args, jobId, createBody };
  try {
    const statusBody = await pollFalStatus(jobContext, context, deadlineAt, jobLinks);
    const resultTarget = resolveJobRequest(restOperation.job.result, jobContext);
    jobLinks.result = resultTarget.description;
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    const result = await resultTarget.client.request({ ...resultTarget.request, signal: context.signal, redactResponse: true, timeoutMs: Math.min(remainingMs, RESULT_FETCH_TIMEOUT_MS) });
    const savedFiles = await saveAllowedDownloads({ operationName: restOperation.name, saveTo: restOperation.download.saveTo, result, context, deadlineAt, allowedHosts: resolveAllowedHosts(context.environment) });
    return { job_id: jobId, status: statusBody.status, result, saved_files: savedFiles };
  } catch (jobError) {
    throw describeJobError(jobError, jobId, jobLinks);
  }
}

async function pollFalStatus(jobContext, context, deadlineAt, jobLinks) {
  const pollTarget = resolveJobRequest(jobContext.operation.job.poll, jobContext);
  jobLinks.status = pollTarget.description;
  const remainingMs = Math.max(1, deadlineAt - Date.now());
  return pollUntilDone({
    readStatus: () => pollTarget.client.request({ ...pollTarget.request, signal: context.signal, redactResponse: true }),
    isDone: (statusBody) => statusBody?.status === COMPLETED && !statusBody.error,
    isFailed: describeFalFailure,
    intervalMs: resolvePollInterval(context.environment, jobContext.operation.job.intervalMs ?? DEFAULT_JOB_INTERVAL_MS),
    timeoutMs: remainingMs,
    signal: context.signal,
  });
}

/**
 * Reads fal's failure report from a status body.
 *
 * @param statusBody - Status response (object)
 * @returns The failure message ("message (error_type)"), or false while not failed (string | false)
 */
export function describeFalFailure(statusBody) {
  if (statusBody?.status !== COMPLETED || !statusBody.error) return false;
  const message = typeof statusBody.error === "string" ? statusBody.error : JSON.stringify(statusBody.error).slice(0, 500);
  return statusBody.error_type ? `${message} (${statusBody.error_type})` : message;
}

function finishOutput(data, source) {
  return { data: source === "tool" ? truncateForTool(data, DEFAULT_TOOL_OUTPUT) : data, next_cursor: null };
}
