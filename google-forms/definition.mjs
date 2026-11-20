/**
 * google-forms plugin definition: the Google Forms API v1 (https://developers.google.com/workspace/forms/api/reference/rest).
 * Read forms and their responses, create forms, edit them with batchUpdate, publish or close them, and manage
 * Pub/Sub watches. Built with the declarative REST layer (docs/declarative-plugins.md); Google credentials come
 * from the shared Google auth files (lib/google-rest-auth.mjs, the same files as google-sheets and google-docs).
 *
 * Agent policy: reads and create_form are tools; the raw `batch_update` (which can delete questions) needs
 * GOOGLE_FORMS_TOOL_ALLOW_EDIT=1 and `set_publish_settings` (which opens or closes a form to respondents) needs
 * GOOGLE_FORMS_TOOL_ALLOW_PUBLISH=1 as tools. Watches push form events to a Pub/Sub topic, so creating, renewing and
 * deleting them is node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createGoogleAuth, createGoogleErrors, GOOGLE_AUTH_ENV, withGoogleCredentials } from "./lib/google-rest-auth.mjs";

// Scopes for the service account grant: edit forms (forms.body also covers reads and watches) and read responses.
const FORMS_SCOPES = "https://www.googleapis.com/auth/forms.body https://www.googleapis.com/auth/forms.responses.readonly";
const FORM_ID = { in: "path", type: "string", required: true, description: "Form id (from its edit URL: /forms/d/<id>/edit)" };
const WATCH_ID = { in: "path", type: "string", required: true, description: "Watch id" };

const formOperations = [
  {
    name: "get_form",
    title: "Get form",
    description: "A form's title, description, settings, questions (items with questionId) and publish state; responderUri is the link respondents use",
    path: "/forms/{form_id}",
    params: { form_id: FORM_ID },
  },
  {
    name: "create_form",
    title: "Create form",
    description: "Create an empty form with a title (add questions with batch_update); it is created in the caller's Drive",
    method: "POST",
    path: "/forms",
    write: "unsafe",
    checkHint: "search Google Drive for the title (google-drive.search_files with mimeType application/vnd.google-apps.form)",
    params: {
      form_title: { in: "body", type: "string", required: true, minLength: 1, wireName: "info.title", description: "Title shown to respondents" },
      document_title: { in: "body", type: "string", wireName: "info.documentTitle", description: "File name in Drive (default: the title)" },
      unpublished: { in: "query", type: "boolean", description: "true: create the form closed to responses (publish later with set_publish_settings); always true for agent tools" },
    },
  },
  {
    name: "batch_update",
    title: "Batch update form",
    description: "Apply batchUpdate requests in order: updateFormInfo, updateSettings, createItem, updateItem, moveItem, deleteItem",
    method: "POST",
    path: "/forms/{form_id}:batchUpdate",
    // Repeating a createItem adds the question twice, so a failed edit is never retried blindly.
    write: "unsafe",
    checkHint: "get_form and compare its items (or revisionId)",
    toolPolicy: "optIn:GOOGLE_FORMS_TOOL_ALLOW_EDIT",
    params: {
      form_id: FORM_ID,
      requests: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 500, description: 'Requests, e.g. [{"createItem": {"item": {"title": "Name", "questionItem": {"question": {"textQuestion": {}}}}, "location": {"index": 0}}}]' },
      include_form_in_response: { in: "body", type: "boolean", wireName: "includeFormInResponse", description: "Return the updated form" },
      required_revision_id: { in: "body", type: "string", wireName: "writeControl.requiredRevisionId", description: "Fail instead of editing if the form changed since this revisionId" },
    },
  },
  {
    name: "set_publish_settings",
    title: "Publish or close form",
    description: "Set whether the form is published and whether it accepts responses (accepting needs published)",
    method: "POST",
    path: "/forms/{form_id}:setPublishSettings",
    // Setting the same state twice has the same effect.
    write: "idempotent",
    toolPolicy: "optIn:GOOGLE_FORMS_TOOL_ALLOW_PUBLISH",
    params: {
      form_id: FORM_ID,
      is_published: { in: "body", type: "boolean", required: true, wireName: "publishSettings.publishState.isPublished" },
      is_accepting_responses: { in: "body", type: "boolean", required: true, wireName: "publishSettings.publishState.isAcceptingResponses" },
    },
    constants: { body: { updateMask: "publishState" } },
  },
];

const responseOperations = [
  {
    name: "list_responses",
    title: "List responses",
    description: "Submitted responses of a form (answers keyed by questionId; match them with get_form items)",
    path: "/forms/{form_id}/responses",
    params: {
      form_id: FORM_ID,
      filter: { in: "query", type: "string", description: 'Only "timestamp > T" or "timestamp >= T" with T in RFC 3339 UTC, e.g. timestamp > 2026-11-01T00:00:00Z' },
    },
    response: { dataPath: "responses", cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 5000, defaultLimit: 100 },
  },
  {
    name: "get_response",
    title: "Get response",
    description: "One response by its responseId",
    path: "/forms/{form_id}/responses/{response_id}",
    params: { form_id: FORM_ID, response_id: { in: "path", type: "string", required: true, description: "responseId from list_responses" } },
  },
];

const watchBody = {
  topic_name: { in: "body", type: "string", required: true, wireName: "watch.target.topic.topicName", description: "Existing Pub/Sub topic owned by the calling project, e.g. projects/my-project/topics/forms" },
  event_type: { in: "body", type: "string", required: true, enum: ["SCHEMA", "RESPONSES"], wireName: "watch.eventType", description: "RESPONSES: new submissions; SCHEMA: form edits" },
  watch_id: { in: "body", type: "string", wireName: "watchId", description: "Optional id (4-63 lowercase letters, digits, hyphens)" },
};

const watchOperations = [
  { name: "list_watches", title: "List watches", description: "Watches the calling Cloud project has on a form", path: "/forms/{form_id}/watches", params: { form_id: FORM_ID }, response: { dataPath: "watches" } },
  {
    name: "create_watch",
    title: "Create watch",
    description: "Publish form events (new responses or edits) to a Pub/Sub topic for 7 days; one watch per event type per project",
    method: "POST",
    path: "/forms/{form_id}/watches",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_watches",
    params: { form_id: FORM_ID, ...watchBody },
  },
  { name: "renew_watch", title: "Renew watch", description: "Extend a watch to 7 days from now", method: "POST", path: "/forms/{form_id}/watches/{watch_id}:renew", write: "idempotent", nodeOnly: true, params: { form_id: FORM_ID, watch_id: WATCH_ID } },
  { name: "delete_watch", title: "Delete watch", description: "Delete a watch", method: "DELETE", path: "/forms/{form_id}/watches/{watch_id}", write: "idempotent", nodeOnly: true, params: { form_id: FORM_ID, watch_id: WATCH_ID } },
];

const restDefinition = defineRestPlugin({
  name: "google-forms",
  version: "0.1.0",
  description: "Google Forms: read forms and responses, create forms, batch edits and publish settings behind opt-ins, Pub/Sub watches (OAuth or service account)",
  apiName: "Google Forms API",
  baseUrl: "https://forms.googleapis.com/v1",
  toolUserToken: { credentialEnv: GOOGLE_AUTH_ENV },
  auth: createGoogleAuth(FORMS_SCOPES),
  errors: createGoogleErrors("error.status"),
  apiRequest: { examplePath: "/forms/<id>" },
  operations: [...formOperations, ...responseOperations, ...watchOperations],
});

// Google publishes new forms by default (open to anyone with the link). Agent tools always create them unpublished,
// so publishing stays behind set_publish_settings and its GOOGLE_FORMS_TOOL_ALLOW_PUBLISH opt-in.
const createUnpublishedForTools = (operation) => ({
  ...operation,
  run: (context) => operation.run(context.source === "tool" ? { ...context, args: { ...context.args, unpublished: true } } : context),
});

const googleDefinition = withGoogleCredentials(restDefinition);
export const pluginDefinition = {
  ...googleDefinition,
  operations: googleDefinition.operations.map((operation) => (operation.name === "create_form" ? createUnpublishedForTools(operation) : operation)),
};
