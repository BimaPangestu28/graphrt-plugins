/**
 * Watches one pooled connection while a call runs: the caller's abort signal
 * and a client-side guard timer (statement timeout + 5 s).
 *
 * On an interruption the backend gets `pg_cancel_backend` from a separate
 * connection. A backend that keeps running (e.g. a DO loop that catches
 * query_canceled) gets `pg_terminate_backend` INTERRUPT_GRACE_MS later, and
 * the call fails then even if the connection never answers. The connection is
 * returned to the pool only when the call succeeded without interruption and
 * the work did not ask for it to be destroyed (`sessionContext.mustDestroy`).
 */
import { cancelled } from "./errors.mjs";
import { mapPostgresError } from "./error-mapping.mjs";
import { PluginError } from "./shared/graphrt-plugin.mjs";

// Past the server-side statement_timeout, the client gives the server this long before giving up itself.
export const CLIENT_GUARD_GRACE_MS = 5000;
// After pg_cancel_backend, the backend is terminated and the call fails this long later.
export const INTERRUPT_GRACE_MS = 3000;

/**
 * Runs `work` on a connection under the abort signal and the guard timer, then returns or destroys the connection.
 *
 * @param sessionContext - `{pgClient, request, createControlClient, mustDestroy}` (object)
 * @param work - `async (sessionContext) => result` (function)
 * @returns The work's result (unknown)
 * @throws PluginError - `cancelled` / `timeout` after an interruption (reads always; writes only if they failed), else the mapped error
 */
export async function runGuardedSession(sessionContext, work) {
  const { pgClient, request } = sessionContext;
  const interruption = createInterruption({
    sendCancel: () => runBackendControl(sessionContext, "pg_cancel_backend"),
    sendTerminate: () => runBackendControl(sessionContext, "pg_terminate_backend"),
  });
  // A checked-out pg client emits 'error' when its socket dies; unhandled, that would crash the plugin process.
  const onClientError = (clientError) => sessionContext.logWarning(`connection error during a call: ${String(clientError?.message ?? clientError)}`);
  pgClient.on?.("error", onClientError);
  const onAbort = () => interruption.interrupt("cancelled");
  if (request.signal?.aborted) interruption.interrupt("cancelled");
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const guardTimer = setTimeout(() => interruption.interrupt("timeout"), request.timeoutMs + CLIENT_GUARD_GRACE_MS);
  const workPromise = work(sessionContext);
  workPromise.catch(() => {});
  let isConnectionReusable = false;
  try {
    const result = await Promise.race([workPromise, interruption.promise]);
    // A read that was interrupted may hold partial or meaningless rows; a write that finished did happen.
    if (interruption.reason() && !request.isWrite) throw new Error("interrupted");
    isConnectionReusable = !interruption.reason() && !sessionContext.mustDestroy;
    return result;
  } catch (workError) {
    const reason = interruption.reason();
    throw reason ? interruptionError(reason, request) : mapPostgresError(workError, { isWrite: request.isWrite, timeoutMs: request.timeoutMs });
  } finally {
    clearTimeout(guardTimer);
    interruption.dispose();
    request.signal?.removeEventListener("abort", onAbort);
    // A pooled client gets the pool's idle listener; a destroyed one keeps ours, since it may still emit.
    if (isConnectionReusable) pgClient.off?.("error", onClientError);
    pgClient.release(isConnectionReusable ? undefined : true);
  }
}

function createInterruption({ sendCancel, sendTerminate }) {
  let interruptionReason = null;
  let rejectPromise = () => {};
  let graceTimer = null;
  const promise = new Promise((_resolve, reject) => {
    rejectPromise = reject;
  });
  promise.catch(() => {});
  return {
    promise,
    reason: () => interruptionReason,
    interrupt(reason) {
      if (interruptionReason) return;
      interruptionReason = reason;
      Promise.resolve().then(sendCancel).catch(() => {});
      graceTimer = setTimeout(() => {
        Promise.resolve().then(sendTerminate).catch(() => {});
        rejectPromise(new Error("interrupted"));
      }, INTERRUPT_GRACE_MS);
    },
    dispose: () => clearTimeout(graceTimer),
  };
}

function interruptionError(reason, request) {
  const writeNote = request.isWrite ? "the statement may or may not have been applied; check before retrying" : "";
  if (reason === "timeout") {
    return new PluginError(`PostgreSQL did not answer within ${request.timeoutMs + CLIENT_GUARD_GRACE_MS} ms${writeNote ? `; ${writeNote}` : ""}`, { kind: "timeout" });
  }
  return cancelled(writeNote);
}

// pg_cancel_backend / pg_terminate_backend on a fresh connection: the pooled one is busy, and the pool may be full.
async function runBackendControl({ pgClient, createControlClient }, functionName) {
  if (!pgClient.processID) return;
  const controlClient = createControlClient();
  try {
    await controlClient.connect();
    await controlClient.query(`SELECT ${functionName}($1)`, [pgClient.processID]);
  } finally {
    await controlClient.end().catch(() => {});
  }
}
