import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,createdTime,parents,owners(emailAddress),webViewLink,trashed";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
const ALL_DRIVES = { supportsAllDrives: "true" };

describeRestPluginContract(pluginDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    get_about: { args: {}, request: { method: "GET", url: `${API}/about`, query: { fields: "user(displayName,emailAddress),storageQuota" } }, response: { body: { user: { emailAddress: "ada@example.com" } } } },
    list_files: {
      args: { q: "'f1' in parents", order_by: "modifiedTime desc", limit: 10 },
      request: { method: "GET", url: `${API}/files`, query: { q: "'f1' in parents", orderBy: "modifiedTime desc", includeItemsFromAllDrives: "true", fields: LIST_FIELDS, supportsAllDrives: "true", pageSize: "10" } },
      response: { body: { files: [{ id: "a" }], nextPageToken: "n2" } },
      expect: { data: [{ id: "a" }] },
    },
    search_files: {
      args: { name_contains: "Q3 'final'", mime_type: "application/pdf", folder_id: "f1" },
      request: {
        method: "GET",
        url: `${API}/files`,
        query: { q: "name contains 'Q3 \\'final\\'' and mimeType = 'application/pdf' and 'f1' in parents and trashed = false", includeItemsFromAllDrives: "true", fields: LIST_FIELDS, supportsAllDrives: "true", pageSize: "50" },
      },
      response: { body: { files: [] } },
    },
    get_file: { args: { file_id: "a" }, request: { method: "GET", url: `${API}/files/a`, query: { fields: `${FILE_FIELDS},description,exportLinks`, supportsAllDrives: "true" } } },
    export_file: { args: { file_id: "doc1", mime_type: "application/pdf" }, request: { method: "GET", url: `${API}/files/doc1/export`, query: { mimeType: "application/pdf" } } },
    download_file: { args: { file_id: "bin1" }, request: { method: "GET", url: `${API}/files/bin1`, query: { alt: "media", supportsAllDrives: "true" } } },
    list_permissions: { args: { file_id: "a" }, request: { method: "GET", url: `${API}/files/a/permissions`, query: { fields: "permissions(id,type,role,emailAddress,domain,displayName,expirationTime)", supportsAllDrives: "true" } } },
    list_drives: { args: {}, request: { method: "GET", url: `${API}/drives`, query: { pageSize: "50" } }, response: { body: { drives: [{ id: "d1" }] } }, expect: { data: [{ id: "d1" }] } },
    create_folder: {
      args: { name: "Reports", parent_ids: ["f1"] },
      request: { method: "POST", url: `${API}/files`, query: { fields: "id,name,webViewLink", supportsAllDrives: "true" }, json: { name: "Reports", parents: ["f1"], mimeType: "application/vnd.google-apps.folder" } },
    },
    copy_file: {
      args: { file_id: "tpl1", name: "Invoice 42" },
      request: { method: "POST", url: `${API}/files/tpl1/copy`, query: { fields: "id,name,webViewLink", supportsAllDrives: "true" }, json: { name: "Invoice 42" } },
    },
    update_file: {
      args: { file_id: "a", name: "Renamed", add_parents: "f2", remove_parents: "f1" },
      request: { method: "PATCH", url: `${API}/files/a`, query: { addParents: "f2", removeParents: "f1", fields: "id,name,parents,webViewLink", supportsAllDrives: "true" }, json: { name: "Renamed" } },
    },
    share_file: {
      args: { file_id: "a", role: "reader", grantee_type: "user", email_address: "bob@example.com", send_notification_email: false },
      request: { method: "POST", url: `${API}/files/a/permissions`, query: { sendNotificationEmail: "false", ...ALL_DRIVES }, json: { role: "reader", type: "user", emailAddress: "bob@example.com" } },
    },
    remove_permission: { args: { file_id: "a", permission_id: "p1" }, request: { method: "DELETE", url: `${API}/files/a/permissions/p1`, query: ALL_DRIVES, body: "absent" }, response: { status: 204 } },
    trash_file: { args: { file_id: "a" }, request: { method: "PATCH", url: `${API}/files/a`, query: ALL_DRIVES, json: { trashed: true } } },
    delete_file: { args: { file_id: "a" }, request: { method: "DELETE", url: `${API}/files/a`, query: ALL_DRIVES, body: "absent" }, response: { status: 204 } },
  },
});
