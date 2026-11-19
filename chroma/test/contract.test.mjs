import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const ROOT = "https://api.trychroma.com";
const DB = `${ROOT}/api/v2/tenants/tenant-uuid-1/databases/news%20db`;
const COLLECTION_ID = "1e30d217-3d78-4f8c-b244-79381dc6a254";
const WHERE = { source: { $eq: "kompas" } };

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool; the extra-paths env lets that path through.
  environment: { CHROMA_URL: ROOT, CHROMA_TENANT: "tenant-uuid-1", CHROMA_DATABASE: "news db", CHROMA_TOOL_API_EXTRA_PATHS: "/anything" },
  checkAuth: (call, credential) => assert.equal(call.headers["x-chroma-token"], credential),
  operations: {
    heartbeat: {
      args: {},
      request: { method: "GET", url: `${ROOT}/api/v2/heartbeat`, query: "absent" },
      response: { body: { "nanosecond heartbeat": 1 } },
      expect: { data: { "nanosecond heartbeat": 1 } },
    },
    get_identity: {
      args: {},
      request: { method: "GET", url: `${ROOT}/api/v2/auth/identity`, query: "absent" },
    },
    list_collections: {
      args: { limit: 2 },
      request: { method: "GET", url: `${DB}/collections`, query: { limit: "2" } },
      response: { body: [{ id: COLLECTION_ID, name: "articles" }] },
      expect: { data: [{ id: COLLECTION_ID, name: "articles" }] },
    },
    count_collections: {
      args: {},
      request: { method: "GET", url: `${DB}/collections_count`, query: "absent" },
      response: { body: 4 },
      expect: { data: 4 },
    },
    get_collection: {
      args: { collection_name: "articles" },
      request: { method: "GET", url: `${DB}/collections/articles`, query: "absent" },
    },
    create_collection: {
      args: { name: "articles", metadata: { lang: "id" } },
      request: { method: "POST", url: `${DB}/collections`, query: "absent", json: { name: "articles", metadata: { lang: "id" }, get_or_create: true } },
    },
    delete_collection: {
      args: { collection_name: "articles" },
      request: { method: "DELETE", url: `${DB}/collections/articles`, query: "absent", body: "absent" },
    },
    count_records: {
      args: { collection_id: COLLECTION_ID },
      request: { method: "GET", url: `${DB}/collections/${COLLECTION_ID}/count`, query: "absent" },
    },
    get_records: {
      args: { collection_id: COLLECTION_ID, where: WHERE, record_limit: 5 },
      request: { method: "POST", url: `${DB}/collections/${COLLECTION_ID}/get`, query: "absent", json: { where: WHERE, include: ["documents", "metadatas"], limit: 5 } },
    },
    query_records: {
      args: { collection_id: COLLECTION_ID, query_embeddings: [[0.1, 0.2]], n_results: 3, where_document: { $contains: "banjir" } },
      request: {
        method: "POST",
        url: `${DB}/collections/${COLLECTION_ID}/query`,
        query: "absent",
        json: { query_embeddings: [[0.1, 0.2]], n_results: 3, where_document: { $contains: "banjir" }, include: ["documents", "metadatas", "distances"] },
      },
    },
    search_records: {
      args: { collection_id: COLLECTION_ID, searches: [{ rank: { $knn: { query: [0.1, 0.2] } }, limit: { limit: 5 } }] },
      request: { method: "POST", url: `${DB}/collections/${COLLECTION_ID}/search`, query: "absent", json: { searches: [{ rank: { $knn: { query: [0.1, 0.2] } }, limit: { limit: 5 } }] } },
    },
    add_records: {
      args: { collection_id: COLLECTION_ID, ids: ["a"], embeddings: [[0.1, 0.2]], documents: ["Banjir di Jakarta"], metadatas: [{ source: "kompas" }] },
      request: {
        method: "POST",
        url: `${DB}/collections/${COLLECTION_ID}/add`,
        query: "absent",
        json: { ids: ["a"], embeddings: [[0.1, 0.2]], documents: ["Banjir di Jakarta"], metadatas: [{ source: "kompas" }] },
      },
    },
    upsert_records: {
      args: { collection_id: COLLECTION_ID, ids: ["a"], embeddings: [[0.3, 0.4]] },
      request: { method: "POST", url: `${DB}/collections/${COLLECTION_ID}/upsert`, query: "absent", json: { ids: ["a"], embeddings: [[0.3, 0.4]] } },
    },
    update_records: {
      args: { collection_id: COLLECTION_ID, ids: ["a"], metadatas: [{ source: "tempo" }] },
      request: { method: "POST", url: `${DB}/collections/${COLLECTION_ID}/update`, query: "absent", json: { ids: ["a"], metadatas: [{ source: "tempo" }] } },
    },
    delete_records: {
      args: { collection_id: COLLECTION_ID, where: WHERE },
      request: { method: "POST", url: `${DB}/collections/${COLLECTION_ID}/delete`, query: "absent", json: { where: WHERE } },
    },
  },
});
