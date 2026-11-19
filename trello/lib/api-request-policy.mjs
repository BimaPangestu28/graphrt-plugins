/**
 * api_request policy for agent tools. Some Trello GET endpoints are secret-bearing (`/tokens/{token}`,
 * `/members/{id}/tokens`, webhooks, applications), so tools may only reach an ALLOWLIST of read paths: boards,
 * lists, cards, checklists, labels, actions, organizations, search, and members without their token or app
 * sub-resources. Paths are decoded, lowercased, `.json` suffixes dropped, and any `.`/`..` segment is refused.
 * Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const RESOURCE_ROOTS = new Set(["boards", "lists", "cards", "checklists", "labels", "actions", "organizations", "search"]);
const MEMBER_SUBRESOURCES = new Set(["boards", "cards", "organizations", "actions", "notifications", "boardstars"]);
const REFUSED_SEGMENTS = new Set(["tokens", "token", "webhooks", "webhook", "applications"]);
const REFUSED_QUERY_KEYS = new Set(["tokens", "webhooks"]);

/**
 * Whether an api_request path is a Trello read an agent tool may call.
 *
 * @param path - api_request `path`, e.g. "/boards/abc/cards?fields=name" (string)
 * @returns True for allowed read paths (boolean)
 *
 * @example
 * isTrelloReadPath("/members/me/boards"); // true
 * isTrelloReadPath("/members/me/tokens"); // false
 */
export function isTrelloReadPath(path) {
  const segments = normalizeSegments(path);
  if (!segments || segments.length === 0) return false;
  if (segments.some((segment) => REFUSED_SEGMENTS.has(segment) || segment === "." || segment === "..")) return false;
  if (RESOURCE_ROOTS.has(segments[0])) return true;
  return segments[0] === "members" && segments.length <= 3 && (segments.length < 3 || MEMBER_SUBRESOURCES.has(segments[2]));
}

/**
 * Whether an api_request asks for a secret-bearing nested resource through a query key (`tokens=all` returns the
 * member's tokens, `webhooks=true` a board's webhooks), in the path's query string or in `query`.
 *
 * @param path - api_request `path` (string)
 * @param query - api_request `query` (object, optional)
 * @returns True when a refused key is present, compared case-insensitively (boolean)
 */
export function hasRefusedQueryKey(path, query) {
  const pathQuery = String(path).split("#")[0].split("?").slice(1).join("?");
  const keys = [...new URLSearchParams(pathQuery).keys(), ...Object.keys(query ?? {})];
  return keys.some((key) => REFUSED_QUERY_KEYS.has(key.trim().toLowerCase()));
}

function normalizeSegments(path) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(path).split(/[?#]/)[0]);
  } catch {
    return null;
  }
  return pathname.toLowerCase().split("/").filter(Boolean).map((segment) => segment.replace(/\.json$/, ""));
}

/**
 * Wraps the generated api_request so tool calls only reach allowed read paths.
 *
 * @param apiRequestOperation - Generated api_request operation (object)
 * @returns Operation with a guarded run (object)
 */
export function restrictApiRequestForTools(apiRequestOperation) {
  return {
    ...apiRequestOperation,
    description: `${apiRequestOperation.description} Agent tools may only read boards, lists, cards, checklists, labels, actions, organizations, search and members (no tokens, webhooks or applications, and no tokens or webhooks query keys).`,
    run: (context) => {
      const isRefusedForTool = !isTrelloReadPath(context.args?.path ?? "") || hasRefusedQueryKey(context.args?.path ?? "", context.args?.query);
      if (context.source === "tool" && isRefusedForTool) {
        throw new PluginError("api_request as an agent tool only reads boards, lists, cards, checklists, labels, actions, organizations, search and members; token, webhook and application paths and the tokens/webhooks query keys are refused", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
