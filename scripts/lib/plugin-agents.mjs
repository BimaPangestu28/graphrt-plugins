/**
 * Ready-made agents of a plugin: `graphrt-agents.json`, an optional file next to a plugin's
 * `graphrt-plugin.json`, and the workflow files it names.
 *
 * A ready-made agent is a finished workflow that graphrt Desktop offers on its New agent screen while the
 * plugin is installed. Picking it creates the agent as written: no AI model writes or changes the workflow.
 * The graphrt runtime does not read the file, so a plugin that has one still loads in every runtime version.
 *
 *   { "agents": [ { "id": "make-invoice", "title": "Make an invoice",
 *                   "description": "Asks for the client and the items, then makes the invoice PDF.",
 *                   "language": "en", "workflow": "agents/make-invoice.yaml" } ] }
 *
 * Item fields:
 * - `id`: lowercase letters, digits and `-`, at most 64 characters, once per file
 * - `title`: what the card is called, at most 120 characters
 * - `description`: one or two sentences for a business user, at most 400 characters
 * - `language`: optional, two lowercase letters (`en`, `id`): the language the agent asks and answers in
 * - `workflow`: the workflow file, a relative `.yaml` path inside the plugin (`/` separators, no `..`), a plain
 *   file of at most 64 KiB
 *
 * Because nobody reviews the workflow before it runs, it may only use steps that cannot reach outside the
 * plugin: a short list of core nodes and the plugin's own operations, and every operation that creates or
 * changes something comes after the person's approval (see findWorkflowProblems).
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_FILE_NAME = "graphrt-agents.json";
export const MAX_AGENTS_FILE_BYTES = 64 * 1024;
export const MAX_AGENT_WORKFLOW_BYTES = 64 * 1024;
export const MAX_AGENTS = 20;
export const MAX_AGENT_TITLE_LENGTH = 120;
export const MAX_AGENT_DESCRIPTION_LENGTH = 400;
/** Core node kinds a ready-made agent may use: none of them reaches the network, a shell, code or a model. */
export const SAFE_CORE_NODE_KINDS = Object.freeze(["start", "end", "answer", "human-input", "template-transform", "if-else", "variable-aggregator"]);
/** An operation whose name starts with one of these only reads; every other one needs the person's approval first. */
export const READ_OPERATION_PREFIXES = Object.freeze(["get", "list", "search", "find", "read", "fetch", "lookup"]);

const ITEM_KEYS = new Set(["id", "title", "description", "language", "workflow"]);
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;
const WORKFLOW_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.yaml$/;
// Control characters other than a line break have no place in a card's text.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0009\u000B-\u001F\u007F]/;

/**
 * Lists what is wrong with one agents item.
 *
 * @param item - An entry of `agents` (any)
 * @returns Problems, empty when the item is valid (string[])
 */
export function findAgentProblems(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return ["must be an object"];
  if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) return ["needs an `id` of lowercase letters, digits and `-` (at most 64 characters)"];
  const problems = Object.keys(item).filter((key) => !ITEM_KEYS.has(key)).map((key) => `unknown field \`${key}\``);
  for (const [field, maxLength] of [["title", MAX_AGENT_TITLE_LENGTH], ["description", MAX_AGENT_DESCRIPTION_LENGTH]]) {
    const text = item[field];
    if (typeof text !== "string" || text.trim() === "") problems.push(`needs a \`${field}\``);
    else if ([...text].length > maxLength) problems.push(`\`${field}\` is longer than ${maxLength} characters`);
    else if (CONTROL_CHARACTER_PATTERN.test(text)) problems.push(`\`${field}\` contains a control character`);
  }
  if (item.language !== undefined && (typeof item.language !== "string" || !LANGUAGE_PATTERN.test(item.language))) problems.push("`language` must be two lowercase letters such as en or id");
  if (typeof item.workflow !== "string" || !WORKFLOW_PATH_PATTERN.test(item.workflow) || item.workflow.split("/").some((segment) => segment === "." || segment === "..")) {
    problems.push("`workflow` must be a relative .yaml path inside the plugin, e.g. agents/make-invoice.yaml (no `..`, no leading `/`)");
  }
  return problems;
}

/**
 * Reads the text of a `graphrt-agents.json`.
 *
 * @param agentsText - The file's text (string)
 * @returns `{agents, problems}`: the valid items in file order, and every problem as "<id or position>: <what>";
 *   a file that is not usable at all has no agents (object)
 */
export function parsePluginAgents(agentsText) {
  if (Buffer.byteLength(agentsText) > MAX_AGENTS_FILE_BYTES) return { agents: [], problems: [`the file is larger than ${MAX_AGENTS_FILE_BYTES} bytes`] };
  let document;
  try {
    document = JSON.parse(agentsText);
  } catch (parseError) {
    return { agents: [], problems: [`not valid JSON: ${parseError.message}`] };
  }
  if (document === null || typeof document !== "object" || !Array.isArray(document.agents)) return { agents: [], problems: ["must be an object with an `agents` list"] };
  const agents = [];
  const problems = Object.keys(document).filter((key) => key !== "agents").map((key) => `unknown field \`${key}\``);
  if (document.agents.length > MAX_AGENTS) problems.push(`at most ${MAX_AGENTS} agents`);
  const seenIds = new Set();
  document.agents.slice(0, MAX_AGENTS).forEach((item, index) => {
    const itemProblems = findAgentProblems(item);
    const itemName = typeof item?.id === "string" && ID_PATTERN.test(item.id) ? item.id : `agents[${index}]`;
    if (itemProblems.length === 0 && seenIds.has(item.id)) itemProblems.push("is listed twice");
    problems.push(...itemProblems.map((problem) => `${itemName}: ${problem}`));
    if (itemProblems.length > 0) return;
    seenIds.add(item.id);
    agents.push(item);
  });
  return { agents, problems };
}

/**
 * Lists what is wrong with the workflow file an agent names.
 *
 * @param pluginDirectory - The plugin's directory (string)
 * @param workflowPath - The item's `workflow`, already checked by findAgentProblems (string)
 * @returns Problems, empty when it is a plain file of at most 64 KiB reached through plain folders (string[])
 */
export function findWorkflowFileProblems(pluginDirectory, workflowPath) {
  const segments = workflowPath.split("/");
  let currentPath = pluginDirectory;
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    let stats;
    try {
      // lstat: a link is refused whatever it points at, so the file can never lead out of the plugin.
      stats = lstatSync(currentPath);
    } catch {
      return [`\`${workflowPath}\` does not exist`];
    }
    const isLast = index === segments.length - 1;
    if (isLast ? !stats.isFile() : !stats.isDirectory()) return [`\`${workflowPath}\` must be a plain file in plain folders (no links)`];
    if (isLast && stats.size > MAX_AGENT_WORKFLOW_BYTES) return [`\`${workflowPath}\` is larger than ${MAX_AGENT_WORKFLOW_BYTES} bytes`];
  }
  return [];
}

/**
 * Lists what makes a workflow unfit to be a ready-made agent of a plugin.
 *
 * A fit workflow uses only SAFE_CORE_NODE_KINDS and the plugin's own operations, and every operation that is
 * not a read (see READ_OPERATION_PREFIXES) can only be reached through a `human-input` step that waits for the
 * person without a time limit.
 *
 * @param workflow - The parsed workflow document (object)
 * @param pluginName - The plugin the agent belongs to (string)
 * @returns Problems, empty when the workflow is fit (string[])
 */
export function findWorkflowProblems(workflow, pluginName) {
  const nodes = workflow?.graph?.nodes;
  const edges = workflow?.graph?.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return ["must have `graph.nodes` and `graph.edges` lists"];
  if (nodes.some((node) => node === null || typeof node !== "object" || typeof node.id !== "string" || typeof node.type !== "string")) return ["every node needs an `id` and a `type`"];
  const problems = [];
  const operationPrefix = `${pluginName}.`;
  const isOwnOperation = (node) => node.type.startsWith(operationPrefix) && node.type.length > operationPrefix.length;
  for (const node of nodes) {
    if (!SAFE_CORE_NODE_KINDS.includes(node.type) && !isOwnOperation(node)) problems.push(`step \`${node.id}\` uses \`${node.type}\`; a ready-made agent may only use ${SAFE_CORE_NODE_KINDS.join(", ")} and ${operationPrefix}* steps`);
    // An approval that answers itself after a while is no approval.
    if (node.type === "human-input" && ["expire_after_ms", "on_expire", "timeout", "timeout_ms"].some((key) => node[key] !== undefined)) problems.push(`step \`${node.id}\` must wait for the person without a time limit`);
  }
  const startNodes = nodes.filter((node) => node.type === "start");
  if (startNodes.length !== 1) return [...problems, "must have exactly one `start` step"];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  // Everything that can run before any approval: walk from start, and do not walk past a human-input step.
  const reachedWithoutApproval = new Set([startNodes[0].id]);
  const queue = [startNodes[0].id];
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (nodesById.get(currentId)?.type === "human-input") continue;
    for (const edge of edges) {
      if (edge?.source !== currentId || reachedWithoutApproval.has(edge.target)) continue;
      reachedWithoutApproval.add(edge.target);
      queue.push(edge.target);
    }
  }
  for (const node of nodes) {
    if (!isOwnOperation(node) || !reachedWithoutApproval.has(node.id)) continue;
    const operationName = node.type.slice(operationPrefix.length);
    const isRead = READ_OPERATION_PREFIXES.some((prefix) => operationName === prefix || operationName.startsWith(`${prefix}_`));
    if (!isRead) problems.push(`step \`${node.id}\` (${node.type}) creates or changes something and can run before the person approves; put a human-input step before it on every path`);
  }
  return problems;
}
