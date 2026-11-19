import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

describeRestPluginContract(pluginDefinition, {
  // Tool-side guards (path allowlist, move opt-in) are tested in dropbox.test.mjs; here every destination is allowed.
  environment: { DROPBOX_TOOL_PATH_ALLOWLIST: "*" },
  operations: {
    get_current_account: {
      args: {},
      request: { method: "POST", url: `${API}/users/get_current_account`, query: "absent", body: "absent" },
      response: { body: { account_id: "dbid:1", email: "ada@example.com" } },
      expect: { data: { account_id: "dbid:1", email: "ada@example.com" } },
    },
    get_space_usage: { args: {}, request: { method: "POST", url: `${API}/users/get_space_usage`, query: "absent", body: "absent" } },
    list_folder: {
      args: { path: "/Reports", recursive: true, page_size: 100 },
      request: { method: "POST", url: `${API}/files/list_folder`, query: "absent", json: { path: "/Reports", recursive: true, limit: 100 } },
      response: { body: { entries: [{ ".tag": "file", name: "q3.pdf" }], cursor: "c1", has_more: true } },
      expect: { data: { entries: [{ ".tag": "file", name: "q3.pdf" }], cursor: "c1", has_more: true } },
    },
    list_folder_continue: { args: { cursor: "c1" }, request: { method: "POST", url: `${API}/files/list_folder/continue`, query: "absent", json: { cursor: "c1" } } },
    get_metadata: { args: { path: "/Reports/q3.pdf" }, request: { method: "POST", url: `${API}/files/get_metadata`, query: "absent", json: { path: "/Reports/q3.pdf" } } },
    search: {
      args: { query: "invoice", folder_path: "/Finance", max_results: 20, filename_only: true, file_extensions: ["pdf"] },
      request: { method: "POST", url: `${API}/files/search_v2`, query: "absent", json: { query: "invoice", options: { path: "/Finance", max_results: 20, filename_only: true, file_extensions: ["pdf"] } } },
    },
    search_continue: { args: { cursor: "s1" }, request: { method: "POST", url: `${API}/files/search/continue_v2`, query: "absent", json: { cursor: "s1" } } },
    download_file: {
      args: { path: "/Reports/q3.pdf" },
      request: { method: "POST", url: `${CONTENT}/files/download`, query: "absent", body: "absent", headers: { "Dropbox-API-Arg": '{"path":"/Reports/q3.pdf"}' } },
    },
    upload_file: {
      args: { file: "https://files.contract.example/notes.txt", path: "/Agent/notes.txt", mode: "overwrite" },
      request: { method: "POST", url: `${CONTENT}/files/upload`, query: "absent", file: { contentType: "application/octet-stream" }, headers: { "Dropbox-API-Arg": '{"path":"/Agent/notes.txt","mode":"overwrite"}' } },
    },
    create_folder: { args: { path: "/Reports/2026" }, request: { method: "POST", url: `${API}/files/create_folder_v2`, query: "absent", json: { path: "/Reports/2026" } } },
    move: {
      args: { from_path: "/a.txt", to_path: "/Archive/a.txt", autorename: true },
      request: { method: "POST", url: `${API}/files/move_v2`, query: "absent", json: { from_path: "/a.txt", to_path: "/Archive/a.txt", autorename: true } },
    },
    copy: { args: { from_path: "/a.txt", to_path: "/b.txt" }, request: { method: "POST", url: `${API}/files/copy_v2`, query: "absent", json: { from_path: "/a.txt", to_path: "/b.txt" } } },
    delete: { args: { path: "/old.txt" }, request: { method: "POST", url: `${API}/files/delete_v2`, query: "absent", json: { path: "/old.txt" } } },
    create_shared_link: {
      args: { path: "/Reports/q3.pdf", audience: "team", access: "viewer" },
      request: { method: "POST", url: `${API}/sharing/create_shared_link_with_settings`, query: "absent", json: { path: "/Reports/q3.pdf", settings: { audience: "team", access: "viewer" } } },
    },
    list_shared_links: { args: { path: "/Reports/q3.pdf", direct_only: true }, request: { method: "POST", url: `${API}/sharing/list_shared_links`, query: "absent", json: { path: "/Reports/q3.pdf", direct_only: true } } },
    get_temporary_link: { args: { path: "/Reports/q3.pdf" }, request: { method: "POST", url: `${API}/files/get_temporary_link`, query: "absent", json: { path: "/Reports/q3.pdf" } } },
  },
});
