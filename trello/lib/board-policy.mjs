/**
 * Board allowlist for agent tool writes. Boards can be public or shared with other workspaces, so an agent that
 * may write anywhere could copy private data onto a board other people read (exfiltration). Tool calls that create
 * or change cards, lists, comments, checklists, labels or card members therefore need the target board in
 * TRELLO_TOOL_BOARD_ALLOWLIST (comma-separated board ids as returned by get_board's `id`, or `*` for any board).
 * When it is unset, tool writes are refused. The board is found with a read before the write (cards, lists and
 * checklists have an `idBoard`). Workflow nodes are not limited.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { pathSegment } from "./shared/path.mjs";

export const BOARD_ALLOWLIST_ENV = "TRELLO_TOOL_BOARD_ALLOWLIST";
const LOOKUP_PATHS = { card: "/cards", list: "/lists", checklist: "/checklists" };

/**
 * Parses the allowlist env value.
 *
 * @param allowlistText - e.g. "5f1b..., 60aa..." or "*" (string, optional)
 * @returns Board ids; `["*"]` allows any (string[])
 */
export function parseBoardAllowlist(allowlistText) {
  return String(allowlistText ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Wraps a write operation so tool calls first check the boards it touches.
 *
 * @param operation - Operation (object)
 * @param listTargets - `(args) => [{kind: "board" | "card" | "list" | "checklist", id}]`; undefined ids are skipped (function)
 * @returns Operation with a guarded run (object)
 */
export function guardToolBoardWrite(operation, listTargets) {
  return {
    ...operation,
    description: `${operation.description} (agent tools: only on boards in ${BOARD_ALLOWLIST_ENV})`,
    run: async (context) => {
      if (context.source === "tool") await assertToolBoardsAllowed(context, listTargets(context.args).filter((target) => target.id !== undefined));
      return operation.run(context);
    },
  };
}

async function assertToolBoardsAllowed({ client, environment, signal }, targets) {
  const allowedBoards = parseBoardAllowlist(environment?.[BOARD_ALLOWLIST_ENV]);
  if (allowedBoards.length === 0) {
    throw new PluginError(`Agent tools may only write to boards listed in ${BOARD_ALLOWLIST_ENV} (board ids, or "*" for any board); it is unset. Use a workflow node, or set it`, { kind: "permission_denied" });
  }
  if (allowedBoards.includes("*")) return;
  for (const target of targets) {
    const boardId = await resolveBoardId(client, target, signal);
    if (!allowedBoards.includes(boardId)) {
      throw new PluginError(`Agent tools may only write to boards listed in ${BOARD_ALLOWLIST_ENV}; the ${target.kind} ${target.id} is on board ${boardId}`, { kind: "permission_denied" });
    }
  }
}

async function resolveBoardId(client, target, signal) {
  if (target.kind === "board") return String(target.id);
  const found = await client.request({ method: "GET", path: `${LOOKUP_PATHS[target.kind]}/${pathSegment(target.id)}`, query: { fields: "idBoard" }, signal, redactResponse: true });
  if (typeof found?.idBoard !== "string") {
    throw new PluginError(`Could not find the board of ${target.kind} ${target.id} to check ${BOARD_ALLOWLIST_ENV}`, { kind: "api_error" });
  }
  return found.idBoard;
}
