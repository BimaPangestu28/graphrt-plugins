/**
 * Link filtering for `get_links` (pure functions).
 */
import { invalidInput } from "./errors.mjs";
import { matchesWildcard } from "./wildcard.mjs";

export const LINK_SCOPES = ["all", "same_host", "same_domain"];
export const MAX_PATTERN_LENGTH = 300;

/**
 * Filters links by scope and an optional wildcard pattern.
 *
 * - `same_host`: the page's host name, ignoring a leading `www.`.
 * - `same_domain`: that host or any subdomain of it.
 * - `pattern`: matched case-insensitively against the absolute URL; `*` is a wildcard.
 *   A pattern without `*` matches anywhere in the URL (substring).
 *
 * @param links - `[{url, text}]` from collectLinks (object[])
 * @param options - `{pageUrl, scope, pattern}` (object)
 * @returns Matching links (object[])
 * @throws PluginError kind `invalid_input` - Unknown scope or a too-long pattern
 *
 * @example
 * filterLinks(links, { pageUrl: "https://www.example.com/", scope: "same_domain", pattern: "blog" });
 */
export function filterLinks(links, { pageUrl, scope = "all", pattern }) {
  const urlPattern = validateLinkFilter({ scope, pattern });
  const pageHost = stripWww(new URL(pageUrl).hostname.toLowerCase());
  return links.filter((link) => isInScope(link.url, pageHost, scope) && (!urlPattern || matchesWildcard(urlPattern, link.url.toLowerCase())));
}

/**
 * Checks `scope` and `pattern` before any page is opened.
 *
 * @param filter - `{scope, pattern}` (object)
 * @returns The wildcard pattern to match, or null for none (string | null)
 * @throws PluginError kind `invalid_input` - Unknown scope or a too-long pattern
 */
export function validateLinkFilter({ scope = "all", pattern }) {
  if (!LINK_SCOPES.includes(scope)) throw invalidInput(`\`scope\` must be one of ${LINK_SCOPES.join(", ")}`);
  return buildUrlPattern(pattern);
}

function buildUrlPattern(pattern) {
  const trimmedPattern = String(pattern ?? "").trim().toLowerCase();
  if (!trimmedPattern) return null;
  if (trimmedPattern.length > MAX_PATTERN_LENGTH) throw invalidInput(`\`pattern\` must be at most ${MAX_PATTERN_LENGTH} characters`);
  return trimmedPattern.includes("*") ? trimmedPattern : `*${trimmedPattern}*`;
}

function isInScope(linkUrl, pageHost, scope) {
  if (scope === "all") return true;
  const linkHost = stripWww(new URL(linkUrl).hostname.toLowerCase());
  if (scope === "same_host") return linkHost === pageHost;
  return linkHost === pageHost || linkHost.endsWith(`.${pageHost}`);
}

function stripWww(hostname) {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}
