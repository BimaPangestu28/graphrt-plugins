/**
 * Agent tool opt-ins for hand-written plugins (the declarative layer's `toolPolicy: "optIn:<ENV>"` and `nodeOnly`,
 * for operations built on shared/lib/operations).
 *
 * An operation wrapped with requireToolOptIn refuses tool calls (`source: "tool"`) unless its opt-in env is "1".
 * Workflow nodes are never limited: their author chose the action. The refusal happens before any request.
 * Recipient allowlists for sends and direct messages are checked separately, with lib/recipient-policy.mjs.
 *
 * This file is identical in whatsapp-api, x-api, threads-api, linkedin-api, tiktok-api and meta-api.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Refuses a tool call when the opt-in env is not "1". Nodes always pass.
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param operationName - Operation name, for the message (string)
 * @param optInEnv - Env that must be "1", e.g. "X_TOOL_ALLOW_POST" (string)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - A tool call without the opt-in
 *
 * @example
 * assertToolOptIn({ source: "tool", environment: { X_TOOL_ALLOW_POST: "1" } }, "create_post", "X_TOOL_ALLOW_POST");
 */
export function assertToolOptIn({ source, environment }, operationName, optInEnv) {
  if (source !== "tool" || environment?.[optInEnv] === "1") return;
  throw new PluginError(`\`${operationName}\` is disabled for agent tools; set ${optInEnv}=1 to allow it, or use a workflow node`, {
    kind: "permission_denied",
  });
}

/**
 * Wraps an operation so tool calls need the opt-in env; the description says so, as the declarative layer does.
 *
 * @param optInEnv - Env that must be "1" for tool calls (string)
 * @param extraCondition - Further condition for the description only, e.g. "the recipient is in X_ALLOWLIST"
 *   (string, optional; the operation checks it itself)
 * @returns `(operation) => operation` (function)
 *
 * @example
 * requireToolOptIn("X_TOOL_ALLOW_POST")(createPostOperation);
 */
export function requireToolOptIn(optInEnv, extraCondition) {
  const condition = extraCondition ? `${optInEnv}=1 and ${extraCondition}` : `${optInEnv}=1`;
  return (operation) => ({
    ...operation,
    description: `${operation.description} (as an agent tool only when ${condition})`,
    run: async (context) => {
      assertToolOptIn(context, operation.name, optInEnv);
      return operation.run(context);
    },
  });
}

/**
 * Makes an operation a workflow node only: it is never offered to an LLM as a tool.
 *
 * @param operation - Operation (object)
 * @returns Operation with `nodeOnly: true` (object)
 */
export function makeNodeOnly(operation) {
  return { ...operation, nodeOnly: true };
}

/**
 * Applies a policy wrapper to the named operations.
 *
 * @param operations - Plugin operations (object[])
 * @param wrappersByName - `{operationName: (operation) => operation}` (object)
 * @returns New operation list in the same order (object[])
 * @throws Error - A named operation does not exist (a typo would silently leave it unguarded)
 */
export function applyAgentPolicy(operations, wrappersByName) {
  const knownNames = new Set(operations.map((operation) => operation.name));
  const unknownNames = Object.keys(wrappersByName).filter((operationName) => !knownNames.has(operationName));
  if (unknownNames.length > 0) throw new Error(`agent policy names unknown operations: ${unknownNames.join(", ")}`);
  return operations.map((operation) => (wrappersByName[operation.name] ? wrappersByName[operation.name](operation) : operation));
}

/**
 * Builds the wrapper map for a group of operations that share one wrapper.
 *
 * @param operationNames - Operation names (string[])
 * @param wrapper - `(operation) => operation` (function)
 * @returns `{operationName: wrapper}` (object)
 */
export function wrapEach(operationNames, wrapper) {
  return Object.fromEntries(operationNames.map((operationName) => [operationName, wrapper]));
}
