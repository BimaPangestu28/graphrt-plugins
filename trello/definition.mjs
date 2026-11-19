/**
 * trello plugin definition: the Trello REST API v1 (https://developer.atlassian.com/cloud/trello/rest/). Boards,
 * lists, cards, comments, checklists, labels and members. Built with the declarative REST layer
 * (docs/declarative-plugins.md). Auth is the API key plus a user token in Trello's documented OAuth-style
 * Authorization header (lib/trello-auth.mjs), so neither appears in URLs. Trello documents that query parameters
 * may be replaced by a JSON body, so writes send JSON (comment text stays out of URLs and logs).
 *
 * Agent policy: tool writes only reach boards in TRELLO_TOOL_BOARD_ALLOWLIST (lib/board-policy.mjs; refused while
 * unset), because a public or shared board is a place where private data could be copied. Deleting a card is node
 * only; inviting people to a board is not offered. api_request for tools only reaches an allowlist of read paths
 * (lib/api-request-policy.mjs), never tokens, webhooks or applications.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { API_KEY_ENV, authorizeTrello, TOKEN_ENV } from "./lib/trello-auth.mjs";
import { BOARD_ALLOWLIST_ENV, guardToolBoardWrite } from "./lib/board-policy.mjs";
import { restrictApiRequestForTools } from "./lib/api-request-policy.mjs";

const BOARD_ID = { in: "path", type: "string", required: true, description: "Board id or short link (from the board URL)" };
const LIST_ID = { in: "path", type: "string", required: true, description: "List id" };
const CARD_ID = { in: "path", type: "string", required: true, description: "Card id or short link" };
const fieldsParam = (description = "Comma-separated fields to return, e.g. name,url (default: Trello's default set)") => ({ in: "query", type: "string", description });
// Trello's `pos`. Never a param named `position`: graphrt reserves that key on workflow nodes.
const positionParam = (description) => ({ in: "body", type: "string", wireName: "pos", description: `${description}: top, bottom or a positive number` });
const cardFields = {
  name: { in: "body", type: "string", description: "Card name" },
  description: { in: "body", type: "string", wireName: "desc", description: "Card description (markdown)" },
  card_position: positionParam("Position in the list"),
  due: { in: "body", type: "string", description: "Due date, ISO 8601, e.g. 2026-12-01T09:00:00Z" },
  start: { in: "body", type: "string", description: "Start date, ISO 8601" },
  due_complete: { in: "body", type: "boolean", wireName: "dueComplete", description: "Whether the due date is done" },
  member_ids: { in: "body", type: "array", items: { type: "string" }, wireName: "idMembers", description: "Member ids (board members) assigned to the card" },
  label_ids: { in: "body", type: "array", items: { type: "string" }, wireName: "idLabels", description: "Label ids of the board" },
};

const readOperations = [
  { name: "get_me", title: "Current member", description: "The member who owns the token", path: "/members/me", params: { fields: fieldsParam() } },
  {
    name: "list_boards",
    title: "List boards",
    description: "Boards of the current member",
    path: "/members/me/boards",
    params: { filter: { in: "query", type: "string", enum: ["all", "open", "closed", "members", "organization", "public", "starred"], default: "open" }, fields: fieldsParam("Comma-separated board fields, e.g. name,url,closed") },
  },
  { name: "get_board", title: "Get board", description: "One board", path: "/boards/{board_id}", params: { board_id: BOARD_ID, fields: fieldsParam() } },
  {
    name: "list_lists",
    title: "List lists",
    description: "Lists (columns) of a board",
    path: "/boards/{board_id}/lists",
    params: { board_id: BOARD_ID, filter: { in: "query", type: "string", enum: ["all", "open", "closed", "none"], default: "open" }, fields: fieldsParam() },
  },
  { name: "list_board_cards", title: "Board cards", description: "Open cards of a board", path: "/boards/{board_id}/cards", params: { board_id: BOARD_ID, fields: fieldsParam() } },
  { name: "list_list_cards", title: "List cards", description: "Cards in one list", path: "/lists/{list_id}/cards", params: { list_id: LIST_ID, fields: fieldsParam() } },
  { name: "get_card", title: "Get card", description: "One card", path: "/cards/{card_id}", params: { card_id: CARD_ID, fields: fieldsParam() } },
  {
    name: "search",
    title: "Search",
    description: "Search cards (and optionally boards) by text, with Trello's search operators (e.g. label:urgent due:week)",
    path: "/search",
    params: {
      query: { in: "query", type: "string", required: true, minLength: 1, description: "Search text" },
      model_types: { in: "query", type: "array", items: { type: "string", enum: ["actions", "boards", "cards", "members", "organizations"] }, wireName: "modelTypes", default: ["cards"], description: "What to search" },
      board_ids: { in: "query", type: "array", items: { type: "string" }, wireName: "idBoards", description: "Only these boards (default: all of the member's boards)" },
      cards_limit: { in: "query", type: "integer", min: 1, max: 1000, description: "Maximum cards (default 10)" },
      partial: { in: "query", type: "boolean", description: "Match the start of words" },
    },
  },
  {
    name: "list_card_actions",
    title: "Card comments and actions",
    description: "Actions on a card; by default its comments (filter commentCard), newest first",
    path: "/cards/{card_id}/actions",
    params: { card_id: CARD_ID, filter: { in: "query", type: "string", default: "commentCard", description: "Action types, comma-separated (e.g. commentCard,updateCard), or all" } },
  },
  { name: "list_card_checklists", title: "Card checklists", description: "Checklists of a card with their items", path: "/cards/{card_id}/checklists", params: { card_id: CARD_ID } },
  { name: "list_board_labels", title: "Board labels", description: "Labels defined on a board", path: "/boards/{board_id}/labels", params: { board_id: BOARD_ID } },
  { name: "list_board_members", title: "Board members", description: "Members of a board (ids for card assignment)", path: "/boards/{board_id}/members", params: { board_id: BOARD_ID } },
];

const writeOperations = [
  {
    name: "create_list",
    title: "Create list",
    description: "Add a list (column) to a board",
    method: "POST",
    path: "/lists",
    write: "unsafe",
    checkHint: "list_lists for the board and look for the name",
    params: { board_id: { in: "body", type: "string", required: true, wireName: "idBoard", description: "Board id" }, name: { in: "body", type: "string", required: true, minLength: 1 }, list_position: positionParam("Position on the board") },
  },
  {
    name: "create_card",
    title: "Create card",
    description: "Create a card in a list",
    method: "POST",
    path: "/cards",
    write: "unsafe",
    checkHint: "list_list_cards for the list and look for the name",
    params: { list_id: { in: "body", type: "string", required: true, wireName: "idList", description: "List id" }, ...cardFields, name: { ...cardFields.name, required: true, minLength: 1 } },
  },
  {
    name: "update_card",
    title: "Update card",
    description: "Change a card's name, description, dates, list (move within the board), members or labels, or archive it (closed: true)",
    method: "PUT",
    path: "/cards/{card_id}",
    write: "idempotent",
    params: {
      card_id: CARD_ID,
      ...cardFields,
      list_id: { in: "body", type: "string", wireName: "idList", description: "Move to this list" },
      closed: { in: "body", type: "boolean", description: "true archives the card, false restores it" },
    },
  },
  {
    name: "add_comment",
    title: "Add comment",
    description: "Comment on a card (board members may be notified of @mentions)",
    method: "POST",
    path: "/cards/{card_id}/actions/comments",
    write: "unsafe",
    checkHint: "list_card_actions for the card and look for the comment",
    params: { card_id: CARD_ID, text: { in: "body", type: "string", required: true, minLength: 1, description: "Comment text (markdown)" } },
  },
  {
    name: "create_checklist",
    title: "Create checklist",
    description: "Add a checklist to a card",
    method: "POST",
    path: "/cards/{card_id}/checklists",
    write: "unsafe",
    checkHint: "list_card_checklists for the card",
    params: { card_id: CARD_ID, name: { in: "body", type: "string", required: true, minLength: 1 }, checklist_position: positionParam("Position on the card") },
  },
  {
    name: "add_checklist_item",
    title: "Add checklist item",
    description: "Add an item to a checklist",
    method: "POST",
    path: "/checklists/{checklist_id}/checkItems",
    write: "unsafe",
    checkHint: "list_card_checklists for the card",
    params: {
      checklist_id: { in: "path", type: "string", required: true, description: "Checklist id" },
      name: { in: "body", type: "string", required: true, minLength: 1 },
      item_position: positionParam("Position in the checklist"),
      checked: { in: "body", type: "boolean" },
      due: cardFields.due,
    },
  },
  {
    name: "update_checklist_item",
    title: "Update checklist item",
    description: "Check or uncheck a checklist item, or rename it",
    method: "PUT",
    path: "/cards/{card_id}/checkItem/{check_item_id}",
    write: "idempotent",
    params: {
      card_id: CARD_ID,
      check_item_id: { in: "path", type: "string", required: true, description: "Checklist item id" },
      state: { in: "body", type: "string", enum: ["complete", "incomplete"] },
      name: { in: "body", type: "string" },
    },
  },
  {
    name: "add_label_to_card",
    title: "Add label",
    description: "Add one of the board's labels to a card",
    method: "POST",
    path: "/cards/{card_id}/idLabels",
    write: "unsafe",
    checkHint: "get_card and look at idLabels",
    params: { card_id: CARD_ID, label_id: { in: "body", type: "string", required: true, wireName: "value", description: "Label id (list_board_labels)" } },
  },
  {
    name: "add_member_to_card",
    title: "Assign member",
    description: "Assign a board member to a card (the member must already be on the board)",
    method: "POST",
    path: "/cards/{card_id}/idMembers",
    write: "unsafe",
    checkHint: "get_card and look at idMembers",
    params: { card_id: CARD_ID, member_id: { in: "body", type: "string", required: true, wireName: "value", description: "Member id (list_board_members)" } },
  },
  { name: "delete_card", title: "Delete card", description: "Delete a card permanently (archive it with update_card closed: true instead)", method: "DELETE", path: "/cards/{card_id}", write: "unsafe", nodeOnly: true, checkHint: "get_card (not_found when deleted)", params: { card_id: CARD_ID } },
];

export const restDefinition = defineRestPlugin({
  name: "trello",
  version: "0.1.0",
  description: "Trello: boards, lists, cards, comments, checklists, labels and members; agent writes limited to allowed boards, deletes node only",
  apiName: "Trello REST API",
  baseUrl: "https://api.trello.com/1",
  auth: { type: "custom", env: TOKEN_ENV, authorize: authorizeTrello },
  extraEnv: [API_KEY_ENV, BOARD_ALLOWLIST_ENV],
  // Errors are plain text ("invalid token", "unauthorized permission requested") or {"message", "error"}; 429
  // bodies name the limit (API_TOKEN_LIMIT_EXCEEDED / API_KEY_LIMIT_EXCEEDED).
  errors: {
    messagePath: ["message", "text"],
    codePath: "error",
    kindByCode: { API_TOKEN_LIMIT_EXCEEDED: "rate_limited", API_KEY_LIMIT_EXCEEDED: "rate_limited" },
  },
  apiRequest: { examplePath: "/boards/{board_id}/actions" },
  operations: [...readOperations, ...writeOperations],
});

const cardTarget = (args) => ({ kind: "card", id: args.card_id });
const boardTargets = {
  create_list: (args) => [{ kind: "board", id: args.board_id }],
  create_card: (args) => [{ kind: "list", id: args.list_id }],
  update_card: (args) => [cardTarget(args), { kind: "list", id: args.list_id }],
  add_comment: (args) => [cardTarget(args)],
  create_checklist: (args) => [cardTarget(args)],
  add_checklist_item: (args) => [{ kind: "checklist", id: args.checklist_id }],
  update_checklist_item: (args) => [cardTarget(args)],
  add_label_to_card: (args) => [cardTarget(args)],
  add_member_to_card: (args) => [cardTarget(args)],
};

const wrapOperation = (operation) => {
  if (operation.name === "api_request") return restrictApiRequestForTools(operation);
  const listTargets = boardTargets[operation.name];
  return listTargets ? guardToolBoardWrite(operation, listTargets) : operation;
};

export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map(wrapOperation) };
