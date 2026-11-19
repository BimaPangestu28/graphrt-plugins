/**
 * Todoist safety helpers:
 *   - `GET /user` returns the account's API `token` and a `websocket_url` that embeds a token, so get_user drops both
 *     fields from every result (nodes and tools).
 *   - api_request as an agent tool may only read projects, sections, tasks, labels, comments and folders. Other GET
 *     endpoints return secrets or private links (`/user`, backups with download URLs, uploads, forwarding email
 *     addresses, workspace invitation codes). Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const SECRET_USER_FIELDS = ["token", "websocket_url"];
const READ_PATH_PATTERN = /^\/(projects|sections|tasks|labels|comments|folders)(\/[^/]+)*$/;

/**
 * Removes secret-bearing fields from a Todoist user object.
 *
 * @param user - Body of GET /user (object)
 * @returns A copy without SECRET_USER_FIELDS (object); other values are returned unchanged
 */
export function stripUserSecrets(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return user;
  return Object.fromEntries(Object.entries(user).filter(([fieldName]) => !SECRET_USER_FIELDS.includes(fieldName)));
}

/**
 * Wraps get_user so its result never carries the token fields.
 *
 * @param operation - Generated get_user operation (object)
 * @returns Operation with a filtered result (object)
 */
export function withoutUserSecrets(operation) {
  return {
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      return { ...result, data: stripUserSecrets(result.data) };
    },
  };
}

/**
 * Normalises an api_request path for matching: no query or fragment, percent-decoded, lower case, without a
 * trailing slash or `.json` suffix. Returns null for paths with empty, `.` or `..` segments or bad encoding.
 *
 * @param path - api_request `path`, e.g. "/Tasks/abc/?x=1" (string)
 * @returns Normalised pathname, or null (string | null)
 *
 * @example
 * normalizeApiPath("/Tasks/abc.json?x=1"); // "/tasks/abc"
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
 * Whether an api_request path is an allowed read for agent tools.
 *
 * @param path - api_request `path` (string)
 * @returns True for project, section, task, label, comment and folder paths (boolean)
 */
export function isAllowedReadPath(path) {
  const pathname = normalizeApiPath(path);
  return pathname !== null && READ_PATH_PATTERN.test(pathname);
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
    description: `${apiRequestOperation.description} Agent tools may only read /projects, /sections, /tasks, /labels, /comments and /folders paths.`,
    run: (context) => {
      if (context.source === "tool" && !isAllowedReadPath(context.args?.path ?? "")) {
        throw new PluginError("api_request as an agent tool only reads /projects, /sections, /tasks, /labels, /comments and /folders (other endpoints return tokens, download links or invitation codes); use a workflow node", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
