import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// "To: ada@example.com\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n
//  Content-Transfer-Encoding: base64\r\n\r\nSGVsbG8=" as base64url (checked byte by byte in mime-message.test.mjs).
const RAW_HELLO = Buffer.from(
  "To: ada@example.com\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=",
).toString("base64url");
const RAW_EMPTY_DRAFT = Buffer.from("Subject: \r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n").toString("base64url");

describeRestPluginContract(pluginDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    get_profile: { args: {}, request: { method: "GET", url: `${API}/profile`, query: "absent" }, response: { body: { emailAddress: "ada@example.com" } } },
    list_messages: {
      args: { q: "is:unread newer_than:7d", label_ids: ["INBOX", "UNREAD"], limit: 10 },
      request: { method: "GET", url: `${API}/messages`, query: { q: "is:unread newer_than:7d", labelIds: ["INBOX", "UNREAD"], maxResults: "10" } },
      response: { body: { messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "p2" } },
      expect: { data: [{ id: "m1", threadId: "t1" }] },
    },
    get_message: {
      args: { message_id: "m1", format: "metadata", metadata_headers: ["From", "Subject"] },
      request: { method: "GET", url: `${API}/messages/m1`, query: { format: "metadata", metadataHeaders: ["From", "Subject"] } },
    },
    get_attachment: { args: { message_id: "m1", attachment_id: "a1" }, request: { method: "GET", url: `${API}/messages/m1/attachments/a1`, query: "absent" }, response: { body: { size: 5, data: "SGVsbG8" } } },
    send_message: {
      args: { to: ["ada@example.com"], subject: "Hi", text: "Hello", thread_id: "t1" },
      request: { method: "POST", url: `${API}/messages/send`, query: "absent", json: { raw: RAW_HELLO, threadId: "t1" } },
      response: { body: { id: "m9", threadId: "t1", labelIds: ["SENT"] } },
    },
    modify_message: {
      args: { message_id: "m1", remove_label_ids: ["UNREAD", "INBOX"] },
      request: { method: "POST", url: `${API}/messages/m1/modify`, query: "absent", json: { removeLabelIds: ["UNREAD", "INBOX"] } },
    },
    trash_message: { args: { message_id: "m1" }, request: { method: "POST", url: `${API}/messages/m1/trash`, query: "absent", body: "absent" } },
    list_threads: { args: { q: "label:clients" }, request: { method: "GET", url: `${API}/threads`, query: { q: "label:clients", maxResults: "20" } }, response: { body: { threads: [{ id: "t1" }] } } },
    get_thread: { args: { thread_id: "t1", format: "minimal" }, request: { method: "GET", url: `${API}/threads/t1`, query: { format: "minimal" } } },
    modify_thread: { args: { thread_id: "t1", add_label_ids: ["STARRED"] }, request: { method: "POST", url: `${API}/threads/t1/modify`, query: "absent", json: { addLabelIds: ["STARRED"] } } },
    list_labels: { args: {}, request: { method: "GET", url: `${API}/labels`, query: "absent" }, response: { body: { labels: [{ id: "INBOX" }] } }, expect: { data: [{ id: "INBOX" }] } },
    get_label: { args: { label_id: "Label_12" }, request: { method: "GET", url: `${API}/labels/Label_12`, query: "absent" } },
    create_label: {
      args: { name: "Clients/Acme", label_list_visibility: "labelShow" },
      request: { method: "POST", url: `${API}/labels`, query: "absent", json: { name: "Clients/Acme", labelListVisibility: "labelShow" } },
    },
    list_drafts: { args: {}, request: { method: "GET", url: `${API}/drafts`, query: { maxResults: "20" } }, response: { body: { drafts: [] } } },
    get_draft: { args: { draft_id: "r1", format: "full" }, request: { method: "GET", url: `${API}/drafts/r1`, query: { format: "full" } } },
    create_draft: { args: {}, request: { method: "POST", url: `${API}/drafts`, query: "absent", json: { message: { raw: RAW_EMPTY_DRAFT } } }, response: { body: { id: "r2" } } },
    send_draft: { args: { draft_id: "r2" }, request: { method: "POST", url: `${API}/drafts/send`, query: "absent", json: { id: "r2" } } },
  },
});
