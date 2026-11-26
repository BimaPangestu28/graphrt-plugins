/**
 * `download.saveTo` for declarative REST operations: saves the https URLs found at `urlPaths` (with the
 * public-https checks) and the base64 fields at `base64Paths` into the directory named by `envDir`, at most
 * `maxFiles` files, within the call's deadline.
 *
 * A file that cannot be saved (refused URL, HTTP failure, time limit, too many files) becomes `{url | source, error}`,
 * so a paid result is never lost to one failed download. Base64 fields are replaced in the result by
 * "[saved to <path>]" so a large blob does not reach an agent.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PluginError } from "./graphrt-plugin.mjs";
import { collectPathValues, replacePathValues } from "./object-path.mjs";
import { downloadPublicHttpsToFile } from "./public-https-fetch.mjs";
import { saveBase64ToFile } from "./rest-files.mjs";

export const DEFAULT_MAX_FILES = 10;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Lists the https-looking URLs a result holds at `saveTo.urlPaths`.
 *
 * @param saveTo - `download.saveTo` spec (object)
 * @param result - Result to search (any)
 * @returns Unique URL strings (string[])
 */
export function listResultUrls(saveTo, result) {
  const urlValues = (saveTo.urlPaths ?? []).flatMap((urlPath) => collectPathValues(result, urlPath));
  return [...new Set(urlValues.filter((urlValue) => typeof urlValue === "string"))];
}

/**
 * Saves the result's URLs and base64 fields.
 *
 * @param context - `{operation, result, client, environment, signal, deadlineAt}` (object)
 * @returns `{result, savedFiles}`; the result has base64 fields replaced; savedFiles is empty when envDir is unset (Promise<object>)
 * @throws PluginError kinds `invalid_input` (relative directory), `cancelled`
 */
export async function saveDownloads({ operation, result, client, environment, signal, deadlineAt }) {
  const saveTo = operation.download.saveTo;
  const directory = environment?.[saveTo.envDir]?.trim();
  if (!directory) return { result, savedFiles: [] };
  if (!isAbsolute(directory)) throw new PluginError(`${saveTo.envDir} must be an absolute directory path`, { kind: "invalid_input" });
  await mkdir(directory, { recursive: true });
  const fileBudget = { remaining: saveTo.maxFiles ?? DEFAULT_MAX_FILES, batchName: `${operation.name}-${Date.now()}-${randomBytes(3).toString("hex")}`, index: 0 };
  const savedFiles = [];
  const options = { directory, saveTo, fileBudget, client, signal, deadlineAt };
  for (const url of listResultUrls(saveTo, result)) savedFiles.push(await saveUrl(url, options));
  let resultWithPaths = result;
  for (const base64Path of saveTo.base64Paths ?? []) {
    for (const encodedValue of collectPathValues(result, base64Path).filter((value) => typeof value === "string")) {
      const savedFile = await saveBase64(encodedValue, base64Path, options);
      savedFiles.push(savedFile);
      if (savedFile.path) resultWithPaths = replacePathValues(resultWithPaths, base64Path, (value) => (value === encodedValue ? `[saved to ${savedFile.path}]` : value));
    }
  }
  return { result: resultWithPaths, savedFiles };
}

function takeFileName(fileBudget) {
  if (fileBudget.remaining <= 0) return null;
  fileBudget.remaining -= 1;
  fileBudget.index += 1;
  return `${fileBudget.batchName}-${fileBudget.index}`;
}

async function saveUrl(url, { directory, saveTo, fileBudget, client, signal, deadlineAt }) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return { url, error: "not downloaded: the call's time limit was reached" };
  const fileBaseName = takeFileName(fileBudget);
  if (!fileBaseName) return { url, error: `not downloaded: more than maxFiles (${saveTo.maxFiles ?? DEFAULT_MAX_FILES}) files` };
  try {
    const downloadOptions = { directory, fileBaseName, fetchImpl: client.fetchImpl, resolveHostAddresses: client.resolveHostAddresses, signal, maxBytes: saveTo.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES, timeoutMs: remainingMs, label: "result URL" };
    return await downloadPublicHttpsToFile(url, downloadOptions);
  } catch (downloadError) {
    if (downloadError?.kind === "cancelled") throw downloadError;
    return { url, error: String(downloadError?.message ?? downloadError) };
  }
}

async function saveBase64(encodedValue, base64Path, { directory, saveTo, fileBudget }) {
  const fileBaseName = takeFileName(fileBudget);
  if (!fileBaseName) return { source: base64Path, error: `not saved: more than maxFiles (${saveTo.maxFiles ?? DEFAULT_MAX_FILES}) files` };
  try {
    return { source: base64Path, ...(await saveBase64ToFile(encodedValue, { directory, fileBaseName, maxBytes: saveTo.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES })) };
  } catch (saveError) {
    return { source: base64Path, error: String(saveError?.message ?? saveError) };
  }
}
