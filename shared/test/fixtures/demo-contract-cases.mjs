/**
 * Contract cases for the demo REST spec (fixtures/demo-rest-spec.mjs), one per operation.
 */
export const DEMO_CONTRACT_CASES = {
  operations: {
    get_item: {
      args: { item_id: "i-1", fields: ["id", "name"], trace: "t-9" },
      request: { method: "GET", path: "/items/i-1", query: { fields: "id,name" }, headers: { "x-trace-id": "t-9", "x-api-version": "2026-01" } },
    },
    send_message: {
      args: { channel: "general", text: "hi" },
      request: { method: "POST", path: "/channels/general/messages", json: { message: { text: "hi", options: { silent: false } } } },
    },
    replace_item: {
      args: { item_id: "i-1", document: { title: "T" } },
      request: { method: "PUT", path: "/items/i-1", json: { title: "T" } },
    },
    delete_item: { args: { item_id: "i-1" }, request: { method: "DELETE", path: "/items/i-1" } },
    search_items: { args: { q: "shoes" }, request: { method: "POST", path: "/items/search", form: { q: "shoes" } } },
    list_cursor: { args: { status: "open" }, request: { method: "GET", path: "/items", query: { status: "open", page_size: "20" } } },
    list_links: { args: {}, request: { method: "GET", path: "/repos", query: {} } },
    list_pages: { args: {}, request: { method: "GET", path: "/pages", query: {} } },
    list_offsets: { args: {}, request: { method: "POST", path: "/records/query", json: {} } },
    generate_image: { args: { prompt: "cat" }, request: { method: "POST", path: "/images", json: { prompt: "cat" } } },
  },
};
