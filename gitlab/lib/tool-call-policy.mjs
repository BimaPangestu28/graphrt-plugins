/**
 * Extra limits on agent-tool writes, on top of the layer's `toolPolicy` opt-in:
 * - requireAllowedTarget: the write's target (a repository or project) must be listed in an env allowlist, so an
 *   agent that may comment cannot comment anywhere the token reaches (e.g. paste private code into a public issue).
 * - refuseToolArguments: arguments agents may never pass (e.g. CI debug logging, which can print secrets).
 * Workflow nodes are unaffected. This file is identical in github and gitlab; keep it so.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Parses a comma-separated allowlist env value; "*" allows everything.
 *
 * @param envValue - e.g. "acme/api, acme/web" (string, optional)
 * @returns Lowercased, trimmed entries (string[])
 */
export function parseAllowlist(envValue) {
  return String(envValue ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Returns the definition with tool calls of `operationNames` refused unless their target is in `$envName`. While an
 * operation's own opt-in (`toolPolicy` env) is not "1" the check is skipped, so the layer's refusal names that env.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - Target policy (object)
 * @param policy.operationNames - Operations to restrict (string[])
 * @param policy.envName - Allowlist env, comma-separated, `*` = any (string)
 * @param policy.describeTarget - `(args) => string`, the call's target, e.g. "owner/repo" (function)
 * @param policy.label - What a target is, for messages, e.g. "repository" (string)
 * @returns A new definition (object)
 *
 * @example
 * requireAllowedTarget(def, { operationNames: ["create_issue"], envName: "GITHUB_TOOL_ALLOWED_REPOS",
 *   describeTarget: (args) => `${args.owner}/${args.repo}`, label: "repository" });
 */
export function requireAllowedTarget(pluginDefinition, { operationNames, envName, describeTarget, label }) {
  const restricted = new Set(operationNames);
  const optInEnvByName = listOptInEnvs(pluginDefinition);
  const wrapOperation = (operation) => {
    if (!restricted.has(operation.name)) return operation;
    const run = (context) => {
      const optInEnv = optInEnvByName.get(operation.name);
      const optedIn = optInEnv === undefined || context.environment?.[optInEnv] === "1";
      if (context.source === "tool" && optedIn) assertTargetAllowed(operation.name, describeTarget(context.args), parseAllowlist(context.environment?.[envName]), { envName, label });
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function listOptInEnvs(pluginDefinition) {
  const operations = pluginDefinition.restSpec?.operations ?? [];
  return new Map(operations.filter((operation) => operation.toolPolicy).map((operation) => [operation.name, operation.toolPolicy.replace(/^optIn:/, "")]));
}

function assertTargetAllowed(operationName, target, allowlist, { envName, label }) {
  const normalizedTarget = String(target).trim().toLowerCase();
  if (allowlist.includes("*") || allowlist.includes(normalizedTarget)) return;
  throw new PluginError(`\`${operationName}\` as an agent tool may only write to a ${label} listed in ${envName}; ${target} is not listed`, { kind: "permission_denied" });
}

/**
 * Returns the definition with tool calls refused when they pass any of `argumentNames` with a truthy value.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - `{operationNames: string[], argumentNames: string[], reason: string}` (object)
 * @returns A new definition (object)
 */
export function refuseToolArguments(pluginDefinition, { operationNames, argumentNames, reason }) {
  const restricted = new Set(operationNames);
  const wrapOperation = (operation) => {
    if (!restricted.has(operation.name)) return operation;
    const run = (context) => {
      const refusedName = context.source === "tool" ? argumentNames.find((argumentName) => Boolean(context.args?.[argumentName])) : undefined;
      if (refusedName) throw new PluginError(`\`${refusedName}\` is not allowed for agent tools: ${reason}`, { kind: "permission_denied" });
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
