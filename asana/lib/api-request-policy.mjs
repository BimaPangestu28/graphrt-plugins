/**
 * api_request policy for agent tools. Some Asana GET endpoints expose configuration or bearer-like data: webhooks
 * (target URLs), attachments (pre-signed `download_url`s), audit log events and organization exports. So tools may
 * only reach an ALLOWLIST of resource roots (tasks, projects, sections, users, workspaces, teams, tags, stories,
 * portfolios, goals, custom fields, status updates, memberships, time tracking), and any path that mentions a
 * refused resource is refused. Paths are decoded, lowercased, `.json` suffixes dropped and `.`/`..` refused.
 * Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const RESOURCE_ROOTS = new Set([
  "tasks", "projects", "sections", "users", "workspaces", "teams", "tags", "stories", "portfolios", "goals",
  "custom_fields", "project_statuses", "status_updates", "memberships", "team_memberships", "workspace_memberships",
  "project_memberships", "time_tracking_entries", "user_task_lists",
]);
const REFUSED_SEGMENTS = new Set(["webhooks", "attachments", "audit_log_events", "organization_exports", "exports", ".", ".."]);

/**
 * Whether an api_request path is an Asana read an agent tool may call.
 *
 * @param path - api_request `path`, e.g. "/projects/1/tasks?opt_fields=name" (string)
 * @returns True for allowed read paths (boolean)
 *
 * @example
 * isAsanaReadPath("/tasks/123/subtasks"); // true
 * isAsanaReadPath("/webhooks"); // false
 */
export function isAsanaReadPath(path) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(path).split(/[?#]/)[0]);
  } catch {
    return false;
  }
  const segments = pathname.toLowerCase().split("/").filter(Boolean).map((segment) => segment.replace(/\.json$/, ""));
  if (segments.length === 0 || segments.some((segment) => REFUSED_SEGMENTS.has(segment))) return false;
  return RESOURCE_ROOTS.has(segments[0]);
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
    description: `${apiRequestOperation.description} Agent tools may only read tasks, projects, sections, users, workspaces, teams, tags, stories, portfolios, goals and similar resources (no webhooks, attachments, exports or audit logs).`,
    run: (context) => {
      if (context.source === "tool" && !isAsanaReadPath(context.args?.path ?? "")) {
        throw new PluginError("api_request as an agent tool only reads tasks, projects, sections, users, workspaces, teams, tags, stories, portfolios, goals and memberships; webhooks, attachments, exports and audit logs are refused", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
