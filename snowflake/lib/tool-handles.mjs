/**
 * Statement handles that agent tool calls created in this plugin process. Tools may only read or cancel those;
 * any other handle (started by a workflow node, perhaps with a more powerful role) is node only.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MAX_REMEMBERED_HANDLES = 10000;
const toolHandles = new Set();

/**
 * Remembers a handle a tool call created (the oldest is forgotten past 10000).
 *
 * @param handle - Statement handle (string)
 */
export function rememberToolHandle(handle) {
  toolHandles.add(handle);
  if (toolHandles.size > MAX_REMEMBERED_HANDLES) toolHandles.delete(toolHandles.values().next().value);
}

/**
 * Refuses a tool call on a handle no tool call created.
 *
 * @param source - "node" or "tool" (string)
 * @param handle - Statement handle (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolOwnsHandle(source, handle) {
  if (source !== "tool" || toolHandles.has(handle)) return;
  throw new PluginError("Agent tools can only use statement handles that an agent tool call started in this session; use a workflow node for others", { kind: "permission_denied" });
}
