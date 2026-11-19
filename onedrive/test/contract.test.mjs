import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const ITEM_SELECT = "id,name,size,file,folder,parentReference,createdDateTime,lastModifiedDateTime,lastModifiedBy,webUrl";
const page = (items) => ({ body: { value: items, "@odata.nextLink": `${GRAPH}/me/drive/root/children?$skiptoken=abc` } });

describeRestPluginContract(pluginDefinition, {
  // Tool folder checks are tested in onedrive.test.mjs; here every folder is allowed.
  environment: { ONEDRIVE_TOOL_FOLDER_ALLOWLIST: "*" },
  operations: {
    get_drive: { args: {}, request: { method: "GET", url: `${GRAPH}/me/drive`, query: "absent" }, response: { body: { id: "d1", driveType: "personal" } }, expect: { data: { id: "d1", driveType: "personal" } } },
    list_drives: { args: { limit: 5 }, request: { method: "GET", url: `${GRAPH}/me/drives`, query: { $top: "5" } }, response: { body: { value: [{ id: "d1" }] } }, expect: { data: [{ id: "d1" }] } },
    list_root_children: {
      args: { order_by: "name" },
      request: { method: "GET", url: `${GRAPH}/me/drive/root/children`, query: { $select: ITEM_SELECT, $orderby: "name", $top: "50" } },
      response: page([{ id: "i1", name: "Documents", folder: { childCount: 3 } }]),
      expect: { data: [{ id: "i1", name: "Documents", folder: { childCount: 3 } }] },
    },
    list_children: { args: { item_id: "01AB!12", select: ["id", "name"], limit: 10 }, request: { method: "GET", url: `${GRAPH}/me/drive/items/01AB!12/children`, query: { $select: "id,name", $top: "10" } } },
    get_item: { args: { item_id: "01AB" }, request: { method: "GET", url: `${GRAPH}/me/drive/items/01AB`, query: "absent" } },
    get_item_by_path: { args: { item_path: "Documents/Q3 report.pdf" }, request: { method: "GET", url: `${GRAPH}/me/drive/root:/Documents/Q3%20report.pdf:`, query: "absent" } },
    search: { args: { query: "invoice" }, request: { method: "GET", url: `${GRAPH}/me/drive/root/search(q='invoice')`, query: { $select: ITEM_SELECT, $top: "50" } } },
    list_permissions: { args: { item_id: "01AB" }, request: { method: "GET", url: `${GRAPH}/me/drive/items/01AB/permissions`, query: "absent" }, response: { body: { value: [{ id: "p1", roles: ["read"] }] } }, expect: { data: [{ id: "p1", roles: ["read"] }] } },
    upload_file: {
      args: { parent_id: "root", file_name: "notes.txt", file: "https://files.contract.example/notes.txt", conflict_behavior: "rename" },
      request: { method: "PUT", url: `${GRAPH}/me/drive/items/root:/notes.txt:/content`, query: { "@microsoft.graph.conflictBehavior": "rename" }, file: true },
    },
    create_folder: {
      args: { parent_id: "root", name: "Reports" },
      request: { method: "POST", url: `${GRAPH}/me/drive/items/root/children`, query: "absent", json: { name: "Reports", "@microsoft.graph.conflictBehavior": "fail", folder: {} } },
    },
    update_item: {
      args: { item_id: "01AB", name: "q3-final.pdf", parent_id: "01FOLDER" },
      request: { method: "PATCH", url: `${GRAPH}/me/drive/items/01AB`, query: "absent", json: { name: "q3-final.pdf", parentReference: { id: "01FOLDER" } } },
    },
    copy_item: {
      args: { item_id: "01AB", parent_id: "01FOLDER", name: "copy.pdf" },
      request: { method: "POST", url: `${GRAPH}/me/drive/items/01AB/copy`, query: "absent", json: { parentReference: { id: "01FOLDER" }, name: "copy.pdf" } },
    },
    create_sharing_link: {
      args: { item_id: "01AB", link_type: "view", scope: "organization" },
      request: { method: "POST", url: `${GRAPH}/me/drive/items/01AB/createLink`, query: "absent", json: { type: "view", scope: "organization" } },
    },
    invite: {
      args: { item_id: "01AB", recipients: [{ email: "ada@example.com" }], roles: ["read"] },
      request: { method: "POST", url: `${GRAPH}/me/drive/items/01AB/invite`, query: "absent", json: { recipients: [{ email: "ada@example.com" }], roles: ["read"], requireSignIn: true, sendInvitation: false } },
    },
    delete_item: { args: { item_id: "01AB" }, request: { method: "DELETE", url: `${GRAPH}/me/drive/items/01AB`, query: "absent", body: "absent" } },
  },
});
