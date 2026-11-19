/**
 * gmail-api plugin definition: the Gmail API v1 for the signed-in user (https://developers.google.com/workspace/gmail/api/reference/rest).
 * Messages, threads, labels, drafts, attachments and sending. Built with the declarative REST layer
 * (docs/declarative-plugins.md); Google credentials come from the shared Google auth files (lib/google-rest-auth.mjs),
 * and `send_message`/`create_draft` build the MIME message from simple fields (lib/gmail-compose.mjs).
 *
 * Agent policy: sending needs GMAIL_TOOL_ALLOW_SEND=1 as a tool, and GMAIL_TOOL_RECIPIENT_ALLOWLIST further limits
 * tool recipients. Sending a draft and trashing are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { RECIPIENT_ALLOWLIST_ENV, SEND_OPT_IN_ENV, wrapCreateDraft, wrapSendMessage } from "./lib/gmail-compose.mjs";
import { createGoogleAuth, createGoogleErrors, withGoogleCredentials } from "./lib/google-rest-auth.mjs";
import { replaceOperation } from "./lib/recipient-policy.mjs";

const ATTACHMENT_DIR_ENV = "GMAIL_ATTACHMENT_DIR";
const MESSAGE_ID = { in: "path", type: "string", required: true, description: "Gmail message id" };
const THREAD_ID = { in: "path", type: "string", required: true, description: "Gmail thread id" };
const tokenPage = (dataPath, maxLimit) => ({ dataPath, cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "maxResults", maxLimit, defaultLimit: 20 });
const searchParams = {
  q: { in: "query", type: "string", description: 'Gmail search, e.g. "from:ada is:unread newer_than:7d"' },
  label_ids: { in: "query", type: "array", items: { type: "string" }, style: "repeat", wireName: "labelIds", description: "Only items with all these labels, e.g. [INBOX, UNREAD]" },
  include_spam_trash: { in: "query", type: "boolean", wireName: "includeSpamTrash" },
};
const formatParam = (formats) => ({ in: "query", type: "string", enum: formats, description: "full (parsed payload), metadata (headers only), minimal (ids and labels) or raw (base64url RFC 822)" });
const metadataHeaders = { in: "query", type: "array", items: { type: "string" }, style: "repeat", wireName: "metadataHeaders", description: "With format metadata: only these headers, e.g. [From, Subject, Date]" };
const labelChanges = {
  add_label_ids: { in: "body", type: "array", items: { type: "string" }, wireName: "addLabelIds", description: "e.g. [STARRED]" },
  remove_label_ids: { in: "body", type: "array", items: { type: "string" }, wireName: "removeLabelIds", description: "e.g. [UNREAD] to mark read, [INBOX] to archive" },
};

const messageOperations = [
  { name: "get_profile", title: "Mailbox profile", description: "Address, message and thread totals and the current historyId", path: "/profile" },
  { name: "list_messages", title: "List messages", description: "Message ids matching a Gmail search (use get_message for content)", path: "/messages", params: searchParams, response: tokenPage("messages", 500) },
  {
    name: "get_message",
    title: "Get message",
    description: "One message; format metadata with metadataHeaders is the cheapest way to read From/Subject",
    path: "/messages/{message_id}",
    params: { message_id: MESSAGE_ID, format: formatParam(["full", "metadata", "minimal", "raw"]), metadata_headers: metadataHeaders },
  },
  {
    name: "get_attachment",
    title: "Save attachment",
    description: `Download a message attachment into $${ATTACHMENT_DIR_ENV} (attachment ids are in the message payload parts)`,
    path: "/messages/{message_id}/attachments/{attachment_id}",
    params: { message_id: MESSAGE_ID, attachment_id: { in: "path", type: "string", required: true, description: "body.attachmentId of the part" } },
    download: { saveTo: { base64Paths: ["data"], envDir: ATTACHMENT_DIR_ENV, maxBytes: 35 * 1024 * 1024, maxFiles: 1 } },
  },
  {
    name: "send_message",
    title: "Send email",
    description: "Send an email from the signed-in account",
    method: "POST",
    path: "/messages/send",
    write: "unsafe",
    toolPolicy: `optIn:${SEND_OPT_IN_ENV}`,
    checkHint: "list_messages with q \"in:sent\" and the subject",
    // lib/gmail-compose.mjs builds `raw` from to/cc/bcc/subject/text/html.
    params: { raw: { in: "body", type: "string" }, thread_id: { in: "body", type: "string", wireName: "threadId" } },
  },
  {
    name: "modify_message",
    title: "Change labels",
    description: "Add or remove labels on a message (mark read, star, archive)",
    method: "POST",
    path: "/messages/{message_id}/modify",
    write: "idempotent",
    params: { message_id: MESSAGE_ID, ...labelChanges },
  },
  { name: "trash_message", title: "Trash message", description: "Move a message to Trash (deleted after 30 days)", method: "POST", path: "/messages/{message_id}/trash", write: "idempotent", nodeOnly: true, params: { message_id: MESSAGE_ID } },
];

const threadOperations = [
  { name: "list_threads", title: "List threads", description: "Thread ids and snippets matching a Gmail search", path: "/threads", params: searchParams, response: tokenPage("threads", 500) },
  { name: "get_thread", title: "Get thread", description: "A thread with all its messages", path: "/threads/{thread_id}", params: { thread_id: THREAD_ID, format: formatParam(["full", "metadata", "minimal"]), metadata_headers: metadataHeaders } },
  { name: "modify_thread", title: "Change thread labels", description: "Add or remove labels on every message of a thread", method: "POST", path: "/threads/{thread_id}/modify", write: "idempotent", params: { thread_id: THREAD_ID, ...labelChanges } },
];

const labelOperations = [
  { name: "list_labels", title: "List labels", description: "System and user labels (ids for label_ids)", path: "/labels", response: { dataPath: "labels" } },
  { name: "get_label", title: "Get label", description: "One label with message and thread counts", path: "/labels/{label_id}", params: { label_id: { in: "path", type: "string", required: true, description: "Label id, e.g. INBOX or Label_12" } } },
  {
    name: "create_label",
    title: "Create label",
    description: "Create a user label",
    method: "POST",
    path: "/labels",
    write: "unsafe",
    checkHint: "list_labels and look for the name",
    params: {
      name: { in: "body", type: "string", required: true, minLength: 1, description: "Label name; use / for nesting, e.g. Clients/Acme" },
      label_list_visibility: { in: "body", type: "string", enum: ["labelShow", "labelShowIfUnread", "labelHide"], wireName: "labelListVisibility" },
      message_list_visibility: { in: "body", type: "string", enum: ["show", "hide"], wireName: "messageListVisibility" },
    },
  },
];

const draftOperations = [
  { name: "list_drafts", title: "List drafts", description: "Draft ids", path: "/drafts", params: { q: searchParams.q }, response: tokenPage("drafts", 500) },
  { name: "get_draft", title: "Get draft", description: "One draft with its message", path: "/drafts/{draft_id}", params: { draft_id: { in: "path", type: "string", required: true }, format: formatParam(["full", "metadata", "minimal", "raw"]) } },
  {
    name: "create_draft",
    title: "Create draft",
    description: "Save a draft without sending it",
    method: "POST",
    path: "/drafts",
    write: "unsafe",
    checkHint: "list_drafts",
    params: { raw: { in: "body", type: "string", wireName: "message.raw" }, thread_id: { in: "body", type: "string", wireName: "message.threadId" } },
  },
  {
    name: "send_draft",
    title: "Send draft",
    description: "Send an existing draft (its recipients are not checked against the allowlist)",
    method: "POST",
    path: "/drafts/send",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_messages with q \"in:sent\"",
    params: { draft_id: { in: "body", type: "string", required: true, wireName: "id" } },
  },
];

const restDefinition = defineRestPlugin({
  name: "gmail-api",
  version: "0.1.0",
  description: "Gmail API: search and read messages and threads, labels, drafts, attachments, and send mail (agent sends need an opt-in and an optional recipient allowlist)",
  apiName: "Gmail API",
  baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
  auth: createGoogleAuth("https://www.googleapis.com/auth/gmail.modify"),
  extraEnv: [RECIPIENT_ALLOWLIST_ENV],
  errors: createGoogleErrors("error.errors.0.reason"),
  apiRequest: { examplePath: "/history?startHistoryId=1" },
  operations: [...messageOperations, ...threadOperations, ...labelOperations, ...draftOperations],
});

export const pluginDefinition = [
  ["send_message", wrapSendMessage],
  ["create_draft", wrapCreateDraft],
].reduce((definition, [operationName, wrap]) => replaceOperation(definition, operationName, wrap), withGoogleCredentials(restDefinition));
