/**
 * Loads `send_email` attachments into memory, bounded by a total size cap:
 * https URLs are streamed with the cap enforced while reading, local files
 * must be inside EMAIL_ALLOWED_FILE_DIRS (realpath on both sides).
 *
 * URLs: redirects are followed by hand (at most MAX_REDIRECTS), and every hop
 * must be https on a public host. Host names are resolved first and refused
 * when any address is loopback, private, link-local or otherwise internal.
 * fetch resolves the name again, so a DNS server that changes its answer in
 * between (rebinding) is not covered by this check.
 *
 * nodemailer itself is configured with file and URL access disabled, so
 * these checks are the only way content gets into a message.
 */
import { lookup } from "node:dns/promises";
import { constants as fileConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { assertSingleLine } from "./addresses.mjs";
import { cancelled, invalidInput, notFound } from "./errors.mjs";

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const INTERNAL_ADDRESSES = buildInternalAddressList();

/** Gmail and Outlook refuse messages over about 25 MB; base64 adds a third, so raw content stays under 18 MB. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
/** All downloads of one message share this budget, so the send still fits in the operation timeout. */
export const ATTACHMENT_DOWNLOAD_BUDGET_MS = 45000;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

/**
 * Validates attachment specs and loads their content.
 *
 * @param attachmentSpecs - `[{source, filename?, content_type?}]` (object[])
 * @param options.allowedDirectories - Directories local files must be inside (string[])
 * @param options.fetchImpl - fetch implementation (function)
 * @param options.resolveHostAddresses - `async (hostname) => string[]` IP addresses; DNS by default (function, optional)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @param options.maxTotalBytes - Size cap for all attachments together (number, optional)
 * @returns nodemailer attachments `[{filename, content: Buffer, contentType?}]` (Promise<object[]>)
 * @throws PluginError kinds `invalid_input` (bad spec, not allowed, internal host, too big), `not_found`, `network_error`, `cancelled`
 */
export async function loadAttachments(attachmentSpecs = [], options) {
  const { allowedDirectories, fetchImpl = fetch, resolveHostAddresses = resolveWithDns, signal, maxTotalBytes = MAX_TOTAL_ATTACHMENT_BYTES } = options;
  if (attachmentSpecs.length > MAX_ATTACHMENTS) throw invalidInput(`At most ${MAX_ATTACHMENTS} attachments per message`);
  const validatedSpecs = attachmentSpecs.map((spec, index) => validateAttachmentSpec(spec, index));
  const budgetSignal = combineSignals(signal, AbortSignal.timeout(ATTACHMENT_DOWNLOAD_BUDGET_MS));
  const downloadOptions = { fetchImpl, resolveHostAddresses, signal: budgetSignal, callerSignal: signal };
  const loadedAttachments = [];
  let remainingBytes = maxTotalBytes;
  for (const spec of validatedSpecs) {
    const content = /^https:\/\//i.test(spec.source)
      ? await downloadAttachment(spec.source, { ...downloadOptions, maxBytes: remainingBytes })
      : await readLocalAttachment(spec.source, { allowedDirectories, maxBytes: remainingBytes });
    remainingBytes -= content.byteLength;
    loadedAttachments.push({ filename: spec.filename ?? fileNameFromSource(spec.source), content, ...(spec.contentType ? { contentType: spec.contentType } : {}) });
  }
  return loadedAttachments;
}

function validateAttachmentSpec(spec, index) {
  const label = `attachments[${index}]`;
  if (typeof spec !== "object" || spec === null || typeof spec.source !== "string" || !spec.source.trim()) {
    throw invalidInput(`\`${label}\` must be an object with a \`source\` (https URL or absolute path)`);
  }
  const source = assertSingleLine(`${label}.source`, spec.source.trim());
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^https:\/\//i.test(source)) throw invalidInput(`\`${label}.source\` URLs must use https://`);
  if (!/^https:\/\//i.test(source) && !isAbsolute(source)) throw invalidInput(`\`${label}.source\` must be an absolute path or an https URL`);
  const filename = spec.filename === undefined || spec.filename === null || spec.filename === "" ? null : sanitizeFileName(assertSingleLine(`${label}.filename`, String(spec.filename)));
  const contentType = spec.content_type ? String(spec.content_type).trim() : null;
  if (contentType && !CONTENT_TYPE_PATTERN.test(contentType)) throw invalidInput(`\`${label}.content_type\` must be a MIME type such as application/pdf`);
  return { source, filename, contentType };
}

async function readLocalAttachment(localPath, { allowedDirectories, maxBytes }) {
  if (allowedDirectories.length === 0) {
    throw invalidInput("Local attachments are disabled: set EMAIL_ALLOWED_FILE_DIRS to the directories send_email may read from, or use an https URL");
  }
  const resolvedPath = await resolveAllowedPath(localPath, allowedDirectories);
  // stat before open: opening a FIFO or device for reading can block forever.
  if (!(await stat(resolvedPath)).isFile()) throw invalidInput(`${localPath} is not a regular file`);
  // O_NONBLOCK in case the path was swapped for a FIFO after the stat; fstat checks again.
  const fileHandle = await open(resolvedPath, fileConstants.O_RDONLY | fileConstants.O_NONBLOCK);
  try {
    const fileStats = await fileHandle.stat();
    if (!fileStats.isFile()) throw invalidInput(`${localPath} is not a regular file`);
    if (fileStats.size > maxBytes) throw tooLarge(localPath, maxBytes);
    return await fileHandle.readFile();
  } finally {
    await fileHandle.close();
  }
}

// One error for "missing" and "outside the allowlist", so a caller cannot probe which files exist.
async function resolveAllowedPath(localPath, allowedDirectories) {
  const unavailable = () => invalidInput(`${localPath} is not an existing file inside EMAIL_ALLOWED_FILE_DIRS`);
  const resolvedDirectories = (await Promise.all(allowedDirectories.map((directory) => realpath(directory).catch(() => null)))).filter(Boolean);
  if (!isInsideAnyDirectory(resolve(localPath), [...allowedDirectories, ...resolvedDirectories])) throw unavailable();
  const resolvedPath = await realpath(localPath).catch(() => {
    throw unavailable();
  });
  if (!isInsideAnyDirectory(resolvedPath, resolvedDirectories)) throw unavailable();
  return resolvedPath;
}

function isInsideAnyDirectory(candidatePath, directories) {
  return directories.some((directory) => candidatePath.startsWith(directory.endsWith(sep) ? directory : directory + sep));
}

async function downloadAttachment(url, { fetchImpl, resolveHostAddresses, signal, callerSignal, maxBytes }) {
  const response = await fetchFollowingRedirects(url, { fetchImpl, resolveHostAddresses, signal, callerSignal });
  if (response.status === 404) throw notFound(`Attachment URL returned 404: ${url}`);
  if (!response.ok) throw invalidInput(`Attachment URL returned HTTP ${response.status}: ${url}`);
  if (Number(response.headers?.get?.("content-length") ?? 0) > maxBytes) throw tooLarge(url, maxBytes);
  try {
    return await readBodyWithCap(response.body, { maxBytes, url });
  } catch (readError) {
    throw readError instanceof PluginError ? readError : classifyDownloadError(readError, url, callerSignal);
  }
}

// Every hop is checked before it is requested, so a redirect cannot lead to http or an internal host.
async function fetchFollowingRedirects(url, { fetchImpl, resolveHostAddresses, signal, callerSignal }) {
  let currentUrl = url;
  for (let hopCount = 0; hopCount <= MAX_REDIRECTS; hopCount += 1) {
    await assertPublicHttpsUrl(currentUrl, { originalUrl: url, resolveHostAddresses, callerSignal });
    const response = await fetchImpl(currentUrl, { redirect: "manual", signal }).catch((fetchError) => {
      throw classifyDownloadError(fetchError, url, callerSignal);
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel?.().catch(() => {});
    const location = response.headers?.get?.("location");
    if (!location) throw invalidInput(`Attachment URL ${url} answered HTTP ${response.status} without a Location`);
    currentUrl = new URL(location, currentUrl).href;
  }
  throw invalidInput(`Attachment URL ${url} redirected more than ${MAX_REDIRECTS} times`);
}

async function assertPublicHttpsUrl(candidateUrl, { originalUrl, resolveHostAddresses, callerSignal }) {
  const parsedUrl = new URL(candidateUrl);
  const hop = candidateUrl === originalUrl ? "" : ` (redirected to ${candidateUrl})`;
  if (parsedUrl.protocol !== "https:") throw invalidInput(`Attachment URL ${originalUrl} must stay on https${hop}`);
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const refuse = () => invalidInput(`Attachment URL ${originalUrl} points to a loopback, private or link-local host${hop}; only public hosts are allowed`);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw refuse();
  const addresses = isIP(hostname) ? [hostname] : await resolveHostAddresses(hostname).catch((lookupError) => {
    throw classifyDownloadError(lookupError, originalUrl, callerSignal);
  });
  if (addresses.length === 0 || addresses.some(isInternalAddress)) throw refuse();
}

function isInternalAddress(address) {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 6 ? INTERNAL_ADDRESSES.ipv6.check(address, "ipv6") : INTERNAL_ADDRESSES.ipv4.check(address, "ipv4");
}

// One list per family: a BlockList also matches IPv4 input against IPv4-mapped IPv6 rules.
function buildInternalAddressList() {
  const ipv4Subnets = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]];
  // Includes all IPv4-mapped and NAT64 addresses, which could otherwise smuggle an internal IPv4 address.
  const ipv6Subnets = [["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]];
  const buildList = (subnets, family) => {
    const blockList = new BlockList();
    for (const [network, prefix] of subnets) blockList.addSubnet(network, prefix, family);
    return blockList;
  };
  return { ipv4: buildList(ipv4Subnets, "ipv4"), ipv6: buildList(ipv6Subnets, "ipv6") };
}

async function resolveWithDns(hostname) {
  const lookupResults = await lookup(hostname, { all: true, verbatim: true });
  return lookupResults.map((lookupResult) => lookupResult.address);
}

// Stops reading (cancelling the download) as soon as the body passes `maxBytes`.
async function readBodyWithCap(body, { maxBytes, url }) {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of body ?? []) {
    byteCount += chunk.byteLength;
    if (byteCount > maxBytes) throw tooLarge(url, maxBytes);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function classifyDownloadError(downloadError, url, callerSignal) {
  if (callerSignal?.aborted) return cancelled("nothing was sent");
  const reason = downloadError?.name === "TimeoutError" ? `timed out (all attachment downloads share ${ATTACHMENT_DOWNLOAD_BUDGET_MS / 1000} s)` : String(downloadError?.message ?? downloadError);
  return new PluginError(`Downloading attachment ${url} failed: ${reason}. Nothing was sent.`, { kind: "network_error", retryable: true });
}

function combineSignals(callerSignal, timeoutSignal) {
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function fileNameFromSource(source) {
  const rawName = /^https:\/\//i.test(source) ? basename(new URL(source).pathname) : basename(source);
  let decodedName;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    decodedName = rawName;
  }
  return sanitizeFileName(decodedName);
}

function sanitizeFileName(rawName) {
  const safeName = String(rawName).replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200);
  return safeName && safeName !== "." && safeName !== ".." ? safeName : "attachment";
}

function tooLarge(source, maxBytes) {
  return invalidInput(`Attachment ${source} does not fit: attachments may total at most ${Math.round((maxBytes / 1048576) * 100) / 100} MB more`);
}
