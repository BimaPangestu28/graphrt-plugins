/**
 * api_request read-path allowlist for agent tools. Some ClickUp GET endpoints return secrets (webhooks carry their
 * signing `secret`), so "GET only" is not enough: as a tool, api_request may only reach the hierarchy, task, comment
 * and time-tracking reads listed in READ_PATH_PATTERNS. Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const ID = "[^/]+";
export const READ_PATH_PATTERNS = [
  /^\/user$/,
  /^\/team$/,
  new RegExp(`^/team/${ID}/(space|task|time_entries|time_entries/current|goal|view)$`),
  new RegExp(`^/space/${ID}(/(folder|list|tag|view))?$`),
  new RegExp(`^/folder/${ID}(/(list|view))?$`),
  new RegExp(`^/list/${ID}(/(task|member|field|view))?$`),
  new RegExp(`^/task/${ID}(/(comment|time_in_status|member|checklist))?$`),
  new RegExp(`^/view/${ID}(/task)?$`),
];

/**
 * Normalises an api_request path for matching: no query or fragment, percent-decoded, lower case, without a
 * trailing slash or `.json` suffix. Returns null for paths with `.`/`..` segments or bad encoding.
 *
 * @param path - api_request `path`, e.g. "/task/9hz/comment?start=1" (string)
 * @returns Normalised pathname, or null when it cannot be matched safely (string | null)
 *
 * @example
 * normalizeApiPath("/Task/9hz/Comment.json?x=1"); // "/task/9hz/comment"
 */
export function normalizeApiPath(path) {
  let pathname = String(path).split(/[?#]/)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = pathname.toLowerCase().replace(/\.json$/, "").replace(/\/+$/, "").split("/");
  if (segments.some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."))) return null;
  return segments.join("/");
}

/**
 * Whether a path is one of the allowed reads.
 *
 * @param path - api_request `path` (string)
 * @param patterns - Allowed normalised path patterns (RegExp[], default READ_PATH_PATTERNS)
 * @returns True when allowed (boolean)
 */
export function isAllowedReadPath(path, patterns = READ_PATH_PATTERNS) {
  const pathname = normalizeApiPath(path);
  return pathname !== null && patterns.some((pattern) => pattern.test(pathname));
}

/**
 * Wraps the generated api_request so tool calls only reach allowed read paths.
 *
 * @param apiRequestOperation - Generated api_request operation (object)
 * @returns Operation with the same schema and a guarded run (object)
 */
export function restrictApiRequestForTools(apiRequestOperation) {
  return {
    ...apiRequestOperation,
    description: `${apiRequestOperation.description} Agent tools may only read the user, workspaces, spaces, folders, lists, views, tasks, comments and time entries.`,
    run: (context) => {
      if (context.source === "tool" && !isAllowedReadPath(context.args?.path ?? "")) {
        throw new PluginError("api_request as an agent tool only reaches ClickUp hierarchy, task, comment and time-entry reads (other endpoints such as webhooks return secrets); use a workflow node", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
