/**
 * Validation of the URLs callers ask the browser to open: http(s) only, no
 * embedded credentials, bounded length. Host checks live in address-policy.mjs.
 */
import { invalidInput } from "./errors.mjs";
import { normalizeHostname } from "./address-policy.mjs";

export const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Parses a caller URL and checks it may be navigated to.
 *
 * @param rawUrl - URL from the operation arguments (string)
 * @returns `{href, hostname, origin}` with the fragment removed (object)
 * @throws PluginError kind `invalid_input` - Not http(s), malformed, too long, or with user:password@
 *
 * @example
 * parseNavigableUrl("https://example.com/a#top"); // { href: "https://example.com/a", hostname: "example.com", ... }
 * parseNavigableUrl("file:///etc/passwd"); // throws invalid_input
 */
export function parseNavigableUrl(rawUrl) {
  const trimmedUrl = String(rawUrl ?? "").trim();
  if (!trimmedUrl) throw invalidInput("`url` is required");
  if (trimmedUrl.length > MAX_URL_LENGTH) throw invalidInput(`\`url\` is longer than ${MAX_URL_LENGTH} characters`);
  const parsedUrl = parseUrl(trimmedUrl);
  if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    throw invalidInput(`Only http:// and https:// URLs can be opened, got ${parsedUrl.protocol}// (file:, data:, javascript: and others are refused)`);
  }
  if (parsedUrl.username || parsedUrl.password) throw invalidInput("URLs with a user name or password (user:pass@host) are refused");
  parsedUrl.hash = "";
  return { href: parsedUrl.href, hostname: normalizeHostname(parsedUrl.hostname), origin: parsedUrl.origin };
}

/**
 * Tells whether a URL (any string) uses http or https.
 *
 * @param candidateUrl - URL to test (string)
 * @returns true for a parsable http(s) URL (boolean)
 */
export function isHttpUrl(candidateUrl) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(candidateUrl).protocol);
  } catch {
    return false;
  }
}

/**
 * Returns the normalised host name of an http(s) URL, or null.
 *
 * @param candidateUrl - URL (string)
 * @returns Host name or null when the URL is not http(s) (string | null)
 */
export function hostnameOf(candidateUrl) {
  try {
    const parsedUrl = new URL(candidateUrl);
    return ALLOWED_PROTOCOLS.has(parsedUrl.protocol) ? normalizeHostname(parsedUrl.hostname) : null;
  } catch {
    return null;
  }
}

/**
 * Shortens a URL for error messages and logs.
 *
 * @param url - URL (string)
 * @param maxLength - Longest result (number, default 200)
 * @returns The URL, cut with an ellipsis when longer (string)
 */
export function shortenUrl(url, maxLength = 200) {
  const text = String(url);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseUrl(trimmedUrl) {
  try {
    return new URL(trimmedUrl);
  } catch {
    throw invalidInput(`\`url\` is not a valid absolute URL: ${shortenUrl(trimmedUrl)}`);
  }
}
