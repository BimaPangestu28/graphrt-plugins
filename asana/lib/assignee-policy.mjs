/**
 * Assignee policy for agent tools. Asana accepts an email address as `assignee`, and assigning work to an address
 * outside the workspace can invite that person (sharing the task with them). So tool calls may only assign to "me"
 * or to a user gid (a person already known to the workspace, e.g. from list_users); emails need a workflow node.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const ALLOWED_TOOL_ASSIGNEE = /^(me|\d+)$/;

/**
 * Wraps a task write so tool calls refuse email assignees before any request.
 *
 * @param operation - Operation with an `assignee` param (object)
 * @returns Operation with a guarded run (object)
 */
export function guardToolAssignee(operation) {
  return {
    ...operation,
    run: (context) => {
      assertToolAssigneeAllowed(context);
      return operation.run(context);
    },
  };
}

/**
 * Refuses a tool call whose assignee is not "me" or a numeric user gid.
 *
 * @param context - Operation context `{source, args}` (object)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A tool call assigns to an email address or other value
 */
export function assertToolAssigneeAllowed({ source, args }) {
  const assignee = args?.assignee;
  if (source !== "tool" || assignee === undefined || assignee === null || ALLOWED_TOOL_ASSIGNEE.test(String(assignee))) return;
  throw new PluginError('Agent tools may only assign tasks to "me" or a user gid (see list_users); assigning by email can invite people outside the workspace, so use a workflow node for that', { kind: "permission_denied" });
}
