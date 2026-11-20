/**
 * google-docs plugin definition: the Google Docs API v1 (https://developers.google.com/workspace/docs/api/reference/rest).
 * Read a document (optionally every tab), create one, insert text, replace text everywhere (templates), and
 * send any batchUpdate. Built with the declarative REST layer (docs/declarative-plugins.md); Google credentials
 * come from the shared Google auth files (lib/google-rest-auth.mjs); `insert_text` and `replace_all_text` wrap
 * batchUpdate with plain fields (lib/docs-requests.mjs).
 *
 * Agent policy: reads, create, insert and replace are tools; the raw `batch_update` (which can delete ranges,
 * tables and images) needs GOOGLE_DOCS_TOOL_ALLOW_BATCH_UPDATE=1 as a tool.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { wrapInsertText, wrapReplaceAllText } from "./lib/docs-requests.mjs";
import { createGoogleAuth, createGoogleErrors, GOOGLE_AUTH_ENV, withGoogleCredentials } from "./lib/google-rest-auth.mjs";

const DOCUMENT_ID = { in: "path", type: "string", required: true, description: "Document id (from its URL: /document/d/<id>/edit)" };
const BATCH_UPDATE_PATH = "/documents/{document_id}:batchUpdate";
const batchUpdateBody = {
  requests: { in: "body", type: "array", items: { type: "object" }, maxItems: 500, description: "batchUpdate requests, applied in order" },
  required_revision_id: { in: "body", type: "string", wireName: "writeControl.requiredRevisionId", description: "Fail instead of editing if the document changed since this revisionId" },
};
const batchUpdateWrite = (name, title, description, extra = {}) => ({
  name,
  title,
  description,
  method: "POST",
  path: BATCH_UPDATE_PATH,
  // Repeating an insert duplicates the text, so a failed edit is never retried blindly.
  write: "unsafe",
  checkHint: "get_document and look at the text (or its revisionId)",
  params: { document_id: DOCUMENT_ID, ...batchUpdateBody },
  ...extra,
});

const operations = [
  {
    name: "get_document",
    title: "Get document",
    description: "A document's structure and text (body.content, or tabs[] with include_tabs_content)",
    path: "/documents/{document_id}",
    params: {
      document_id: DOCUMENT_ID,
      include_tabs_content: { in: "query", type: "boolean", wireName: "includeTabsContent", description: "Return every tab in tabs[] instead of only the first tab in body" },
      suggestions_view_mode: {
        in: "query",
        type: "string",
        enum: ["DEFAULT_FOR_CURRENT_ACCESS", "SUGGESTIONS_INLINE", "PREVIEW_SUGGESTIONS_ACCEPTED", "PREVIEW_WITHOUT_SUGGESTIONS"],
        wireName: "suggestionsViewMode",
      },
    },
  },
  {
    name: "create_document",
    title: "Create document",
    description: "Create an empty document with a title (in the root of the caller's Drive)",
    method: "POST",
    path: "/documents",
    write: "unsafe",
    checkHint: "search Drive for the title",
    params: { document_title: { in: "body", type: "string", required: true, minLength: 1, wireName: "title", description: "Title of the new document (sent as `title`)" } },
  },
  batchUpdateWrite("insert_text", "Insert text", "Insert text at an index, or append it at the end of the body"),
  batchUpdateWrite("replace_all_text", "Replace text", "Replace every occurrence of a text, e.g. template placeholders like {{name}}"),
  batchUpdateWrite("batch_update", "Batch update", "Apply raw batchUpdate requests (formatting, tables, images, deletions, ...)", {
    toolPolicy: "optIn:GOOGLE_DOCS_TOOL_ALLOW_BATCH_UPDATE",
    params: { document_id: DOCUMENT_ID, ...batchUpdateBody, requests: { ...batchUpdateBody.requests, required: true } },
  }),
];

const restDefinition = defineRestPlugin({
  name: "google-docs",
  version: "0.1.0",
  description: "Google Docs: read documents (with tabs), create, insert text, replace text for templates, raw batch updates (OAuth or service account)",
  apiName: "Google Docs API",
  baseUrl: "https://docs.googleapis.com/v1",
  toolUserToken: { credentialEnv: GOOGLE_AUTH_ENV },
  auth: createGoogleAuth("https://www.googleapis.com/auth/documents"),
  errors: createGoogleErrors("error.status"),
  apiRequest: { examplePath: "/documents/<id>" },
  operations,
});

const wrappers = { insert_text: wrapInsertText, replace_all_text: wrapReplaceAllText };
const googleDefinition = withGoogleCredentials(restDefinition);
export const pluginDefinition = { ...googleDefinition, operations: googleDefinition.operations.map((operation) => wrappers[operation.name]?.(operation) ?? operation) };
