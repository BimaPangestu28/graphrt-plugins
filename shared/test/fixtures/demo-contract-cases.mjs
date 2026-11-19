/**
 * Contract cases for the demo REST spec (fixtures/demo-rest-spec.mjs), one per operation.
 */
const BASE = "https://api.example.com/v1";

export const DEMO_CONTRACT_CASES = {
  operations: {
    get_item: {
      args: { item_id: "i-1", fields: ["id", "name"], trace: "t-9" },
      request: { method: "GET", url: `${BASE}/items/i-1`, query: { fields: "id,name" }, headers: { "x-trace-id": "t-9", "x-api-version": "2026-01" } },
      response: { body: { id: "i-1" } },
      expect: { data: { id: "i-1" } },
    },
    send_message: {
      args: { channel: "general", text: "hi" },
      request: { method: "POST", url: `${BASE}/channels/general/messages`, query: "absent", json: { message: { text: "hi", options: { silent: false } } } },
    },
    replace_item: {
      args: { item_id: "i-1", document: { title: "T" } },
      request: { method: "PUT", url: `${BASE}/items/i-1`, query: "absent", json: { title: "T" } },
    },
    delete_item: { args: { item_id: "i-1" }, request: { method: "DELETE", url: `${BASE}/items/i-1`, query: "absent", body: "absent" } },
    search_items: { args: { q: "shoes" }, request: { method: "POST", url: `${BASE}/items/search`, query: "absent", form: { q: "shoes" } } },
    list_cursor: { args: { status: "open" }, request: { method: "GET", url: `${BASE}/items`, query: { status: "open", page_size: "20" } } },
    list_links: { args: {}, request: { method: "GET", url: `${BASE}/repos`, query: "absent" } },
    list_pages: { args: {}, request: { method: "GET", url: `${BASE}/pages`, query: "absent" } },
    list_offsets: { args: {}, request: { method: "POST", url: `${BASE}/records/query`, query: "absent", json: {} } },
    generate_image: { args: { prompt: "cat" }, request: { method: "POST", url: `${BASE}/images`, query: "absent", json: { prompt: "cat" } } },
    render_audio: { args: { prompt: "rain" }, request: { method: "POST", url: `${BASE}/audio`, query: "absent", json: { prompt: "rain" } } },
    upload_blob: {
      args: { file: "https://files.contract.example/clip.wav", folder: "in" },
      request: { method: "POST", url: `${BASE}/blobs`, query: { folder: "in" }, file: { contentType: "application/octet-stream" } },
    },
  },
};
