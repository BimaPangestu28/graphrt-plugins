/**
 * One time budget for a call that reads file inputs (local files, or https URLs it downloads) and then sends a
 * (usually paid) request with them. The budget starts with the call and ends before the host's timeout. File
 * downloads get the time left minus what the request needs (`minRequestMs`), so a slow input URL can never push
 * the request past the host timeout; and the request is refused, with nothing sent, when less than `minRequestMs`
 * is left. Declarative operations use it automatically (rest-plugin.mjs); hand-written operations use
 * `createTransferBudget` with `readFileInputWithinBudget` and pass `budget.requestTimeoutMs()` as the request's
 * `timeoutMs`.
 */
import { PluginError } from "./graphrt-plugin.mjs";
import { readFileInput } from "./rest-files.mjs";

const HTTPS_URL = /^https:\/\//i;

/**
 * Creates a transfer budget.
 *
 * @param options - Budget settings (object)
 * @param options.totalMs - Time for the whole call, e.g. the host timeout minus a margin (number)
 * @param options.minRequestMs - Time the request needs at least; less than totalMs (number)
 * @param options.maxRequestMs - The request's own timeout (number, default: the time left)
 * @param options.startedAt - Start of the call, ms since epoch (number, default now)
 * @param options.now - Clock, for tests (function, default Date.now)
 * @returns `{deadlineAt, fileReadTimeoutMs(), requestTimeoutMs()}`; both methods throw a non-retryable `timeout`
 *   PluginError when the time left is not enough (object)
 * @throws Error - When totalMs or minRequestMs are not positive, or minRequestMs >= totalMs
 *
 * @example
 * const budget = createTransferBudget({ totalMs: 350000, minRequestMs: 240000, maxRequestMs: 240000 });
 * const image = await readFileInputWithinBudget(args.image, { paramName: "image", fileDirEnv, environment, fetchImpl }, budget);
 * await client.request({ method: "POST", path: "/edit", body, timeoutMs: budget.requestTimeoutMs() });
 */
export function createTransferBudget({ totalMs, minRequestMs, maxRequestMs, startedAt, now = Date.now }) {
  if (!(totalMs > 0)) throw new Error("createTransferBudget: totalMs must be positive");
  if (!(minRequestMs > 0) || minRequestMs >= totalMs) throw new Error("createTransferBudget: minRequestMs must be positive and below totalMs");
  const deadlineAt = (startedAt ?? now()) + totalMs;
  const remainingMs = () => deadlineAt - now();
  const refuse = (problem) => {
    const message = `${problem}: ${Math.max(0, remainingMs())} ms of the call's ${totalMs} ms are left and the request needs ${minRequestMs} ms; nothing was sent`;
    return new PluginError(message, { kind: "timeout", retryable: false });
  };
  return {
    deadlineAt,
    fileReadTimeoutMs: () => {
      const fileReadMs = remainingMs() - minRequestMs;
      if (fileReadMs <= 0) throw refuse("No time left to read the file inputs");
      return fileReadMs;
    },
    requestTimeoutMs: () => {
      const leftMs = remainingMs();
      if (leftMs < minRequestMs) throw refuse("Not enough time left for the request after reading the file inputs");
      return Math.min(maxRequestMs ?? leftMs, leftMs);
    },
  };
}

/**
 * Reads one file input (readFileInput) inside a transfer budget: an https download gets the file-read time.
 *
 * @param fileReference - Absolute local path, or an https URL (string)
 * @param options - readFileInput options: `{paramName, fileDirEnv, environment, maxBytes, fetchImpl, resolveHostAddresses, signal}` (object)
 * @param budget - From createTransferBudget (object)
 * @returns `{bytes, fileName, contentType}` (Promise<object>)
 * @throws PluginError - As readFileInput, or kind `timeout` (not retryable) when no time is left
 */
export function readFileInputWithinBudget(fileReference, options, budget) {
  const reference = String(fileReference);
  const timeoutMs = HTTPS_URL.test(reference) ? budget.fileReadTimeoutMs() : undefined;
  return readFileInput(reference, { ...options, timeoutMs });
}
