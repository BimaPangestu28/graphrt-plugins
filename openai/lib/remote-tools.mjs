/**
 * Remote-tool guard for the openai plugin.
 *
 * Responses API tools of type `mcp` and `connector` make OpenAI send the conversation to a server named in the
 * request. An agent that was prompt-injected could add one and exfiltrate everything it has seen, so agent tool
 * calls may only use them when the operator sets OPENAI_TOOL_ALLOW_REMOTE_TOOLS=1. Workflow nodes are not limited:
 * their tools are written by the workflow author.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const REMOTE_TOOLS_ENV = "OPENAI_TOOL_ALLOW_REMOTE_TOOLS";
const REMOTE_TOOL_TYPES = new Set(["mcp", "connector"]);

/**
 * Wraps an operation so agent tool calls cannot pass remote tools without the opt-in.
 *
 * @param operation - Operation from defineRestPlugin with a `tools` array param (object)
 * @returns Operation with the same schema and a guarded run (object)
 * @throws PluginError kind `permission_denied` - (from run) a remote tool from an agent without the opt-in
 */
export function guardRemoteTools(operation) {
  return {
    ...operation,
    description: `${operation.description} (mcp and connector tools from agents only when ${REMOTE_TOOLS_ENV}=1)`,
    run: (context) => {
      assertNoRemoteTools(context);
      return operation.run(context);
    },
  };
}

function assertNoRemoteTools({ source, args, environment }) {
  if (source !== "tool" || environment?.[REMOTE_TOOLS_ENV] === "1") return;
  const remoteTool = (args.tools ?? []).find((toolDefinition) => REMOTE_TOOL_TYPES.has(toolDefinition?.type));
  if (!remoteTool) return;
  throw new PluginError(`Tools of type \`${remoteTool.type}\` send data to other servers and are disabled for agent tools; set ${REMOTE_TOOLS_ENV}=1 to allow them, or use a workflow node`, {
    kind: "permission_denied",
  });
}
