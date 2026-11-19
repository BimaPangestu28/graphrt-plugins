/**
 * Output downloads limited to the provider's delivery hosts.
 *
 * The shared `download.saveTo` fetches any public https URL found in a result. Model outputs are arbitrary, so a
 * model could return a URL on any host (or a list of text tokens). This wrapper runs the declarative operation
 * with the output directory hidden (so the layer downloads nothing), then saves only the values that are https URLs
 * on an allowed host, with the layer's own `saveDownloads` (public-https checks, size caps, no credential, the
 * call's deadline). URLs on other hosts are listed in `saved_files` with an error instead of being fetched; values
 * that are not URLs (text tokens) are ignored.
 */
import { listResultUrls, saveDownloads } from "./shared/rest-downloads.mjs";
import { DEFAULT_TOOL_OUTPUT, truncateForTool } from "./shared/rest-response.mjs";

/**
 * Splits a comma-separated host list from an env var.
 *
 * @param hostListText - e.g. "cdn.example.com, files.example.org" (string, optional)
 * @returns Lowercased host names (string[])
 */
export function parseHostList(hostListText) {
  return String(hostListText ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
}

/**
 * Whether a value is an https URL on an allowed host: a host suffix (the domain or its subdomains) or an exact extra host.
 *
 * @param candidate - Value from the result (any)
 * @param allowedHosts - `{hostSuffixes, extraHosts}` (object)
 * @returns True when it may be downloaded (boolean)
 */
export function isAllowedDownloadUrl(candidate, { hostSuffixes, extraHosts }) {
  if (typeof candidate !== "string" || !/^https:\/\/\S+$/i.test(candidate)) return false;
  let host;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return false;
  }
  return extraHosts.includes(host) || hostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function looksLikeUrl(candidate) {
  return typeof candidate === "string" && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(candidate);
}

/**
 * Saves the allowed URLs of a result into the output directory.
 *
 * @param options - Settings (object)
 * @param options.operationName - Used in file names (string)
 * @param options.saveTo - The operation's `download.saveTo` spec (object)
 * @param options.result - Result to search (any)
 * @param options.context - Operation context `{client, environment, signal}` (object)
 * @param options.deadlineAt - Absolute deadline, ms since epoch (number)
 * @param options.allowedHosts - `{hostSuffixes, extraHosts}` (object)
 * @returns saved_files entries (Promise<object[]>)
 */
export async function saveAllowedDownloads({ operationName, saveTo, result, context, deadlineAt, allowedHosts }) {
  if (!context.environment?.[saveTo.envDir]?.trim()) return [];
  const urls = listResultUrls(saveTo, result).filter(looksLikeUrl);
  const allowedUrls = urls.filter((url) => isAllowedDownloadUrl(url, allowedHosts));
  const refusedUrls = urls.filter((url) => !allowedUrls.includes(url));
  const urlOnlySaveTo = { ...saveTo, urlPaths: ["[]"], base64Paths: undefined };
  const { savedFiles } = await saveDownloads({ operation: { name: operationName, download: { saveTo: urlOnlySaveTo } }, result: allowedUrls, client: context.client, environment: context.environment, signal: context.signal, deadlineAt });
  const allowedText = [...allowedHosts.hostSuffixes.map((suffix) => `*.${suffix}`), ...allowedHosts.extraHosts].join(", ");
  return [...savedFiles, ...refusedUrls.map((url) => ({ url, error: `not downloaded: not on an allowed delivery host (${allowedText})` }))];
}

/**
 * Wraps a declarative operation with `download.saveTo` so only allowed-host URLs are downloaded.
 *
 * @param operation - Generated operation `{name, run, ...}` (object)
 * @param options - Settings (object)
 * @param options.saveTo - The operation's `download.saveTo` spec (object)
 * @param options.budgetMs - Time from the call's start until downloads must stop (number)
 * @param options.resolveAllowedHosts - `(environment) => {hostSuffixes, extraHosts}` (function)
 * @param options.toolOutput - Tool truncation settings (object, optional)
 * @returns Operation with the same name, schema and policy (object)
 */
export function withRestrictedDownloads(operation, { saveTo, budgetMs, resolveAllowedHosts, toolOutput = DEFAULT_TOOL_OUTPUT }) {
  return {
    ...operation,
    run: async (context) => {
      const deadlineAt = Date.now() + budgetMs;
      const environmentWithoutDownloads = { ...context.environment, [saveTo.envDir]: "" };
      const output = await operation.run({ ...context, source: "node", environment: environmentWithoutDownloads });
      const data = output.data;
      if (!data || typeof data !== "object" || !Object.hasOwn(data, "saved_files")) return finishOutput(output, context.source, toolOutput);
      const savedFiles = await saveAllowedDownloads({ operationName: operation.name, saveTo, result: data.result, context, deadlineAt, allowedHosts: resolveAllowedHosts(context.environment) });
      return finishOutput({ ...output, data: { ...data, saved_files: savedFiles } }, context.source, toolOutput);
    },
  };
}

function finishOutput(output, source, toolOutput) {
  if (source !== "tool") return output;
  return { ...output, data: truncateForTool(output.data, toolOutput) };
}
