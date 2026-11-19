/**
 * An allowlist of read paths for the generated `api_request` when an agent calls it as a tool.
 *
 * The layer already limits tool calls to GET, but some GET endpoints of many APIs return configuration an agent
 * should not see (API keys, SMTP tokens, webhook settings with signing secrets, account settings). So tool calls
 * may only reach paths under a fixed list of prefixes, minus an optional list of blocked prefixes. A `*` prefix
 * segment matches any one segment, so the segments `lists`, `*`, `webhooks` cover every audience's webhooks.
 *
 * Paths are compared without the query and fragment, case-insensitively, with a `.json` suffix removed. Every
 * segment is percent-decoded until it stops changing (so `%252e` is `.`), and the path is refused when a segment
 * is empty, `.` or `..`, holds a decoded `/` or `\`, cannot be decoded, or the raw path has a backslash: a server
 * or proxy could otherwise resolve it to another endpoint. A single trailing slash is allowed. Workflow nodes are
 * unaffected.
 *
 * This file is identical in every plugin that uses it (hubspot, brevo, mailchimp, sendgrid, resend, zoho-crm);
 * keep it so.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MAX_DECODE_ROUNDS = 5;

/**
 * Decodes percent-encoding until the text stops changing.
 *
 * @param text - Possibly (multiply) encoded text (string)
 * @returns Decoded text, or null when it is malformed or still changing after the last round (string | null)
 *
 * @example
 * decodeRepeatedly("%252e%252e"); // ".."
 */
export function decodeRepeatedly(text) {
  let decodedText = text;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let nextText;
    try {
      nextText = decodeURIComponent(decodedText);
    } catch {
      // A malformed percent-encoding cannot be compared safely: treated as not allowed.
      return null;
    }
    if (nextText === decodedText) return decodedText;
    decodedText = nextText;
  }
  return null;
}

/**
 * Splits an api_request path into decoded, lower-cased segments.
 *
 * @param path - e.g. "/templates/d-1?page_size=10" (string)
 * @returns Segments, or null when the path is malformed or has dot, empty or separator segments (string[] | null)
 */
export function splitSafeSegments(path) {
  const pathname = String(path).split(/[?#]/)[0].replace(/\/$/, "");
  if (!pathname.startsWith("/") || pathname.includes("\\")) return null;
  const decodedSegments = pathname.slice(1).split("/").map(decodeRepeatedly);
  if (decodedSegments.some((segment) => segment === null || segment === "" || segment === "." || segment === ".." || /[\\/]/.test(segment))) return null;
  const lowerSegments = decodedSegments.map((segment) => segment.toLowerCase());
  lowerSegments[lowerSegments.length - 1] = lowerSegments.at(-1).replace(/\.json$/, "");
  return lowerSegments;
}

function hasPrefix(segments, prefix) {
  const prefixSegments = prefix.toLowerCase().split("/").filter(Boolean);
  return prefixSegments.every((prefixSegment, index) => (prefixSegment === "*" ? segments[index] !== undefined : segments[index] === prefixSegment));
}

/**
 * Whether a path lies under one of the allowed prefixes and none of the blocked ones (on segment boundaries).
 *
 * @param path - api_request `path` (string)
 * @param allowedPrefixes - e.g. ["/templates", "/suppression"] (string[])
 * @param blockedPrefixes - e.g. ["/emails/receiving"] (string[], optional)
 * @returns True when allowed (boolean)
 *
 * @example
 * isAllowedReadPath("/templates/d-1", ["/templates"]); // true
 * isAllowedReadPath("/templates/%252e%252e/api_keys", ["/templates"]); // false
 */
export function isAllowedReadPath(path, allowedPrefixes, blockedPrefixes = []) {
  const segments = splitSafeSegments(path);
  if (!segments) return false;
  return allowedPrefixes.some((prefix) => hasPrefix(segments, prefix)) && !blockedPrefixes.some((prefix) => hasPrefix(segments, prefix));
}

/**
 * Wraps the generated api_request so tool calls can only reach the allowed read paths.
 *
 * @param apiRequestOperation - Generated api_request operation (object)
 * @param allowedPrefixes - Allowed path prefixes (string[])
 * @param blockedPrefixes - Prefixes refused even under an allowed one (string[], optional)
 * @returns Operation with the same schema and a guarded run (object)
 */
export function restrictApiRequestToReadPaths(apiRequestOperation, allowedPrefixes, blockedPrefixes = []) {
  const prefixList = allowedPrefixes.join(", ");
  const blockedNote = blockedPrefixes.length > 0 ? ` except ${blockedPrefixes.join(", ")}` : "";
  return {
    ...apiRequestOperation,
    description: `${apiRequestOperation.description} Agent tools may only read paths under ${prefixList}${blockedNote}.`,
    run: (context) => {
      if (context.source === "tool" && !isAllowedReadPath(context.args?.path ?? "", allowedPrefixes, blockedPrefixes)) {
        throw new PluginError(`api_request as an agent tool may only read paths under ${prefixList}${blockedNote}; use a workflow node for other endpoints`, { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
