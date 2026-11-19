/**
 * typeform plugin definition: the Typeform Create, Responses, Workspaces and Insights APIs
 * (https://www.typeform.com/developers/) with a personal access token. Built with the declarative REST layer
 * (docs/declarative-plugins.md). The API host follows the account's data center (lib/typeform-region.mjs), and
 * agent api_request calls are limited to an allowlist of read paths (lib/api-request-policy.mjs), because webhook
 * endpoints return their signing secrets.
 *
 * Agent policy: reads are tools; create_form needs TYPEFORM_TOOL_ALLOW_CREATE=1 (forms are public by default);
 * deleting forms and responses is node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { restrictApiRequestForTools } from "./lib/api-request-policy.mjs";
import { BASE_URL_ENV, resolveTypeformBaseUrl } from "./lib/typeform-region.mjs";

const FORM_ID = { in: "path", type: "string", required: true, description: "Form id, e.g. u6nXL7 (the last part of the form URL)" };
const idList = (description) => ({ in: "query", type: "array", items: { type: "string" }, maxItems: 1000, description });
const numberedPage = { dataPath: "items", pagePagination: { pageParam: "page", sizeParam: "page_size", totalPagesPath: "page_count" }, maxLimit: 200, defaultLimit: 50 };

const formOperations = [
  { name: "get_me", title: "Account", description: "The account of the token (alias, email, language)", path: "/me" },
  {
    name: "list_forms",
    title: "List forms",
    description: "Forms the token can access, with ids, titles and links (newest first unless sorted)",
    path: "/forms",
    params: {
      search: { in: "query", type: "string", description: "Only forms whose title contains this text" },
      workspace_id: { in: "query", type: "string", description: "Only forms in this workspace" },
      sort_by: { in: "query", type: "string", enum: ["created_at", "last_updated_at"] },
      order_by: { in: "query", type: "string", enum: ["asc", "desc"] },
    },
    response: numberedPage,
  },
  { name: "get_form", title: "Get form", description: "A form's definition: fields (questions with id and ref), logic, settings, and _links.responses (whose host shows the data center)", path: "/forms/{form_id}", params: { form_id: FORM_ID } },
  {
    name: "create_form",
    title: "Create form",
    description: "Create a form from a Create API form definition ({title, fields, settings, ...})",
    method: "POST",
    path: "/forms",
    bodyMode: "raw",
    write: "unsafe",
    checkHint: "list_forms with search set to the title",
    toolPolicy: "optIn:TYPEFORM_TOOL_ALLOW_CREATE",
    params: { form: { in: "body", type: "object", required: true, description: 'Form definition, e.g. {"title": "Feedback", "fields": [{"title": "Your name?", "type": "short_text"}], "settings": {"is_public": false}}' } },
  },
  { name: "delete_form", title: "Delete form", description: "Delete a form and all its responses permanently", method: "DELETE", path: "/forms/{form_id}", write: "idempotent", nodeOnly: true, params: { form_id: FORM_ID } },
];

const responseOperations = [
  {
    name: "list_responses",
    title: "List responses",
    description: "Submitted responses, newest first (answers keyed by field id/ref); next_cursor pages to older ones. Responses of the last ~30 minutes may be missing",
    path: "/forms/{form_id}/responses",
    params: {
      form_id: FORM_ID,
      since: { in: "query", type: "string", description: "From this time (inclusive): ISO 8601 UTC like 2026-11-01T00:00:00 or a Unix timestamp" },
      until: { in: "query", type: "string", description: "Up to this time (inclusive), same formats" },
      after: { in: "query", type: "string", description: "Only responses submitted after the response with this token" },
      included_response_ids: idList("Only these response ids"),
      excluded_response_ids: idList("Leave out these response ids"),
      response_type: { in: "query", type: "array", items: { type: "string" }, maxItems: 3, description: "started, partial and/or completed (default completed)" },
      search: { in: "query", type: "string", wireName: "query", description: "Exact phrase in answers, hidden fields or variables" },
      fields: { in: "query", type: "array", items: { type: "string" }, maxItems: 100, description: "Only return answers of these field ids" },
      answered_fields: { in: "query", type: "array", items: { type: "string" }, maxItems: 100, description: "Only responses that answered at least one of these field ids" },
    },
    // Newest first by default; the next page is the responses before the last item's token.
    response: { dataPath: "items", lastItemCursor: { itemIdPath: "token", param: "before" }, limitParam: "page_size", maxLimit: 1000, defaultLimit: 100 },
  },
  {
    name: "delete_responses",
    title: "Delete responses",
    description: "Delete responses by id (up to 1000; deletion is queued, unknown ids are ignored)",
    method: "DELETE",
    path: "/forms/{form_id}/responses",
    write: "idempotent",
    nodeOnly: true,
    params: { form_id: FORM_ID, included_response_ids: { ...idList("Response ids to delete"), required: true } },
  },
  { name: "get_insights_summary", title: "Form insights", description: "Form and per-question insights: visits, responses, completion rate, average time (plan-dependent)", path: "/insights/{form_id}/summary", params: { form_id: FORM_ID } },
];

const workspaceOperations = [
  { name: "list_workspaces", title: "List workspaces", description: "Workspaces the token can access, with form counts", path: "/workspaces", params: { search: { in: "query", type: "string", description: "Only workspaces whose name contains this text" } }, response: numberedPage },
  { name: "get_workspace", title: "Get workspace", description: "One workspace with its members and forms link", path: "/workspaces/{workspace_id}", params: { workspace_id: { in: "path", type: "string", required: true } } },
];

export const restDefinition = defineRestPlugin({
  name: "typeform",
  version: "0.1.0",
  description: "Typeform: list and read forms, responses (with filters and paging), insights and workspaces; form creation behind an opt-in, deletes node only (US and EU data centers)",
  apiName: "Typeform API",
  baseUrl: resolveTypeformBaseUrl,
  extraEnv: [BASE_URL_ENV],
  auth: { type: "bearer", env: "TYPEFORM_TOKEN" },
  // Errors are {"code": "...", "description": "...", "details": [...]}; a bad token is 401 UNAUTHORIZED or 403 AUTHENTICATION_ERROR.
  errors: {
    messagePath: ["description", "message"],
    codePath: "code",
    kindByCode: {
      UNAUTHORIZED: "auth_error",
      AUTHENTICATION_ERROR: "auth_error",
      AUTHENTICATION_FAILED: "auth_error",
      INVALID_AUTHORIZATION: "auth_error",
      PAYMENT_REQUIRED: "permission_denied",
      NOT_EXISTING_ID: "not_found",
      FORM_NOT_FOUND: "not_found",
      VALIDATION_ERROR: "invalid_input",
    },
  },
  apiRequest: { examplePath: "/forms/<id>/messages" },
  operations: [...formOperations, ...responseOperations, ...workspaceOperations],
});

// The contract suite runs on restDefinition (its api_request probe uses an arbitrary path); test/contract.test.mjs
// checks the guard on pluginDefinition.
export const pluginDefinition = { ...restDefinition, operations: restDefinition.operations.map((operation) => (operation.name === "api_request" ? restrictApiRequestForTools(operation) : operation)) };
