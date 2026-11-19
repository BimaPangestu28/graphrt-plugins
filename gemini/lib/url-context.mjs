/**
 * URL-context guard for the gemini plugin.
 *
 * The `urlContext` tool makes Google fetch any URL named in the prompt. A prompt-injected agent could use it to
 * reach URLs of an attacker's choosing (and leak data in their query strings), so agent tool calls may only use it
 * when the operator sets GEMINI_TOOL_ALLOW_URL_CONTEXT=1. Workflow nodes are not limited.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const URL_CONTEXT_ENV = "GEMINI_TOOL_ALLOW_URL_CONTEXT";
const URL_CONTEXT_KEYS = ["urlContext", "url_context"];

/**
 * Wraps generate_content so agent tool calls cannot pass the urlContext tool without the opt-in.
 *
 * @param operation - Operation from defineRestPlugin with a `tools` array param (object)
 * @returns Operation with the same schema and a guarded run (object)
 * @throws PluginError kind `permission_denied` - (from run) urlContext from an agent without the opt-in
 */
export function guardUrlContext(operation) {
  return {
    ...operation,
    description: `${operation.description} (urlContext from agents only when ${URL_CONTEXT_ENV}=1)`,
    run: (context) => {
      assertNoUrlContext(context);
      return operation.run(context);
    },
  };
}

function assertNoUrlContext({ source, args, environment }) {
  if (source !== "tool" || environment?.[URL_CONTEXT_ENV] === "1") return;
  const usesUrlContext = (args.tools ?? []).some((toolDefinition) => URL_CONTEXT_KEYS.some((key) => toolDefinition && Object.hasOwn(toolDefinition, key)));
  if (!usesUrlContext) return;
  throw new PluginError(`The urlContext tool makes Google fetch URLs from the prompt and is disabled for agent tools; set ${URL_CONTEXT_ENV}=1 to allow it, or use a workflow node`, {
    kind: "permission_denied",
  });
}
