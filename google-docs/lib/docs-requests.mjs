import { PluginError } from "./shared/graphrt-plugin.mjs";

export const DELETE_OPT_IN_ENV = "GOOGLE_DOCS_TOOL_ALLOW_BATCH_UPDATE";

/**
 * Simple wrappers over documents.batchUpdate (https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate):
 * `insert_text` and `replace_all_text` take plain fields and send a one-request `requests` array, which the
 * declarative layer cannot build from params (dotted wire names make objects, not arrays).
 */

const TAB_ID_PROPERTY = { type: "string", description: "Tab id (default: the first tab)" };

/**
 * Builds an insertText request: at `index`, or at the end of the body when no index is given.
 *
 * @param args - `{text, index?, tab_id?}` (object)
 * @returns One batchUpdate request (object)
 *
 * @example
 * buildInsertTextRequest({ text: "Hi", index: 1 }); // { insertText: { text: "Hi", location: { index: 1 } } }
 */
export function buildInsertTextRequest({ text, index, tab_id: tabId }) {
  const tabField = tabId ? { tabId } : {};
  const target = index === undefined ? { endOfSegmentLocation: { ...tabField } } : { location: { index, ...tabField } };
  return { insertText: { text, ...target } };
}

/**
 * Builds a replaceAllText request. Deleting the matches needs an explicit `delete_matches: true`, so a missing
 * replacement can never silently delete text.
 *
 * @param args - `{find, replace_with?, delete_matches?, match_case?, tab_ids?}` (object)
 * @returns One batchUpdate request (object)
 * @throws PluginError kind `invalid_input` - Neither or both of replace_with and delete_matches
 */
export function buildReplaceAllTextRequest({ find, replace_with: replaceWith, delete_matches: deleteMatches, match_case: matchCase, tab_ids: tabIds }) {
  if (deleteMatches === true && replaceWith !== undefined) throw new PluginError("Give either `replace_with` or `delete_matches: true`, not both", { kind: "invalid_input" });
  if (deleteMatches !== true && replaceWith === undefined) throw new PluginError("`replace_with` is required (to delete the matches, pass `delete_matches: true` instead)", { kind: "invalid_input" });
  const request = { containsText: { text: find, matchCase: matchCase ?? false }, replaceText: deleteMatches === true ? "" : replaceWith };
  if (tabIds?.length) request.tabsCriteria = { tabIds };
  return { replaceAllText: request };
}

const withRequest = (operation, parameters, buildRequest) => ({
  ...operation,
  parameters,
  run: (context) => operation.run({ ...context, args: { document_id: context.args.document_id, requests: [buildRequest(context.args)], required_revision_id: context.args.required_revision_id } }),
});

const documentIdProperty = { type: "string", description: "Document id (from its URL: /document/d/<id>/edit)" };
const revisionProperty = { type: "string", description: "Fail instead of editing if the document changed since this revisionId" };

/**
 * Wraps the declarative insert_text operation.
 *
 * @param operation - Generated operation with body `{requests, writeControl}` (object)
 * @returns Operation taking `{document_id, text, index?, tab_id?}` (object)
 */
export function wrapInsertText(operation) {
  const properties = {
    document_id: documentIdProperty,
    text: { type: "string", minLength: 1, description: "Text to insert; \\n starts a new paragraph" },
    index: { type: "integer", minimum: 1, description: "UTF-16 index to insert at (1 is the start of the body); default: the end of the body" },
    tab_id: TAB_ID_PROPERTY,
    required_revision_id: revisionProperty,
  };
  return withRequest(operation, { type: "object", properties, required: ["document_id", "text"] }, buildInsertTextRequest);
}

/**
 * Wraps the declarative replace_all_text operation.
 *
 * @param operation - Generated operation with body `{requests, writeControl}` (object)
 * @returns Operation taking `{document_id, find, replace_with | delete_matches, match_case?, tab_ids?}` (object)
 */
export function wrapReplaceAllText(operation) {
  const properties = {
    document_id: documentIdProperty,
    find: { type: "string", minLength: 1, description: "Text to find, e.g. {{customer_name}}" },
    // Not in `required` because delete_matches replaces it; the builder refuses calls with neither.
    replace_with: { type: "string", description: "Replacement text (required unless delete_matches is true)" },
    delete_matches: { type: "boolean", description: `true deletes every match instead of replacing it (agent tools need ${DELETE_OPT_IN_ENV}=1)` },
    match_case: { type: "boolean", default: false },
    tab_ids: { type: "array", items: { type: "string" }, description: "Only these tabs (default: all tabs)" },
    required_revision_id: revisionProperty,
  };
  const replaceOperation = withRequest(operation, { type: "object", properties, required: ["document_id", "find"] }, buildReplaceAllTextRequest);
  return { ...replaceOperation, run: (context) => (assertDeletionAllowed(context), replaceOperation.run(context)) };
}

function assertDeletionAllowed({ source, args, environment }) {
  if (source !== "tool" || args.delete_matches !== true || environment?.[DELETE_OPT_IN_ENV] === "1") return;
  throw new PluginError(`replace_all_text with delete_matches is disabled for agent tools; set ${DELETE_OPT_IN_ENV}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
}
