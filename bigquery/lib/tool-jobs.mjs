/**
 * Query jobs that agent tool calls started in this plugin process. Tools may only read results of those; any
 * other job id (started by a workflow node, perhaps reading data an agent should not see) is node only.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MAX_REMEMBERED_JOBS = 10000;
const toolJobs = new Set();

/**
 * Remembers a job id a tool call created (the oldest is forgotten past 10000).
 *
 * @param projectId - Project id (string)
 * @param jobId - Job id (string)
 */
export function rememberToolJob(projectId, jobId) {
  toolJobs.add(`${projectId}\u0000${jobId}`);
  if (toolJobs.size > MAX_REMEMBERED_JOBS) toolJobs.delete(toolJobs.values().next().value);
}

/**
 * Refuses a tool call on a job no tool call created.
 *
 * @param source - "node" or "tool" (string)
 * @param projectId - Project id (string)
 * @param jobId - Job id (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolOwnsJob(source, projectId, jobId) {
  if (source !== "tool" || toolJobs.has(`${projectId}\u0000${jobId}`)) return;
  throw new PluginError("Agent tools can only read results of queries an agent tool call started in this session; use a workflow node for others", { kind: "permission_denied" });
}
