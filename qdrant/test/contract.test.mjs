import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE = "https://xyz-example.eu-central.aws.cloud.qdrant.io:6333";
const FILTER = { must: [{ key: "city", match: { value: "Bandung" } }] };
const ok = (result) => ({ body: { result, status: "ok", time: 0.001 } });

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool; the extra-paths env lets that path through.
  environment: { QDRANT_URL: `${BASE}/`, QDRANT_TOOL_API_EXTRA_PATHS: "/anything" },
  checkAuth: (call, credential) => assert.equal(call.headers["api-key"], credential),
  operations: {
    list_collections: {
      args: {},
      request: { method: "GET", url: `${BASE}/collections`, query: "absent" },
      response: ok({ collections: [{ name: "docs" }] }),
      expect: { data: [{ name: "docs" }] },
    },
    get_collection: {
      args: { collection_name: "docs" },
      request: { method: "GET", url: `${BASE}/collections/docs`, query: "absent" },
      response: ok({ status: "green", points_count: 12 }),
      expect: { data: { status: "green", points_count: 12 } },
    },
    collection_exists: {
      args: { collection_name: "a/b" },
      request: { method: "GET", url: `${BASE}/collections/a%2Fb/exists`, query: "absent" },
    },
    list_aliases: {
      args: {},
      request: { method: "GET", url: `${BASE}/aliases`, query: "absent" },
    },
    create_collection: {
      args: { collection_name: "docs", vectors: { size: 768, distance: "Cosine" } },
      request: { method: "PUT", url: `${BASE}/collections/docs`, query: "absent", json: { vectors: { size: 768, distance: "Cosine" } } },
    },
    delete_collection: {
      args: { collection_name: "docs" },
      request: { method: "DELETE", url: `${BASE}/collections/docs`, query: "absent", body: "absent" },
    },
    query_points: {
      args: { collection_name: "docs", query: { nearest: [0.1, 0.2] }, filter: FILTER, result_limit: 3, search_params: { hnsw_ef: 128 } },
      request: {
        method: "POST",
        url: `${BASE}/collections/docs/points/query`,
        query: "absent",
        json: { query: { nearest: [0.1, 0.2] }, filter: FILTER, params: { hnsw_ef: 128 }, with_payload: true, with_vector: false, limit: 3 },
      },
      response: ok({ points: [{ id: 1, score: 0.9 }] }),
      expect: { data: [{ id: 1, score: 0.9 }] },
    },
    query_points_groups: {
      args: { collection_name: "docs", query: { nearest: [0.1] }, group_by: "document_id", group_size: 2, consistency: "majority" },
      request: {
        method: "POST",
        url: `${BASE}/collections/docs/points/query/groups`,
        query: { consistency: "majority" },
        json: { query: { nearest: [0.1] }, with_payload: true, with_vector: false, group_by: "document_id", group_size: 2 },
      },
    },
    scroll_points: {
      args: { collection_name: "docs", filter: FILTER, limit: 50 },
      request: { method: "POST", url: `${BASE}/collections/docs/points/scroll`, query: "absent", json: { filter: FILTER, with_payload: true, with_vector: false, limit: 50 } },
      response: ok({ points: [{ id: 7 }], next_page_offset: 8 }),
      expect: { data: [{ id: 7 }] },
    },
    get_points: {
      args: { collection_name: "docs", ids: [1, "5c56c793-69f3-4fbf-87e6-c4bf54c28c26"] },
      request: { method: "POST", url: `${BASE}/collections/docs/points`, query: "absent", json: { ids: [1, "5c56c793-69f3-4fbf-87e6-c4bf54c28c26"], with_payload: true, with_vector: false } },
    },
    get_point: {
      args: { collection_name: "docs", point_id: 42 },
      request: { method: "GET", url: `${BASE}/collections/docs/points/42`, query: "absent" },
    },
    count_points: {
      args: { collection_name: "docs", filter: FILTER },
      request: { method: "POST", url: `${BASE}/collections/docs/points/count`, query: "absent", json: { filter: FILTER, exact: true } },
      response: ok({ count: 3 }),
      expect: { data: { count: 3 } },
    },
    facet_counts: {
      args: { collection_name: "docs", key: "city", facet_limit: 5 },
      request: { method: "POST", url: `${BASE}/collections/docs/facet`, query: "absent", json: { key: "city", limit: 5 } },
    },
    upsert_points: {
      args: { collection_name: "docs", points: [{ id: 1, vector: [0.1, 0.2], payload: { city: "Bandung" } }] },
      request: { method: "PUT", url: `${BASE}/collections/docs/points`, query: { wait: "true" }, json: { points: [{ id: 1, vector: [0.1, 0.2], payload: { city: "Bandung" } }] } },
    },
    set_payload: {
      args: { collection_name: "docs", payload: { status: "reviewed" }, points: [1, 2], wait: false },
      request: { method: "POST", url: `${BASE}/collections/docs/points/payload`, query: { wait: "false" }, json: { payload: { status: "reviewed" }, points: [1, 2] } },
    },
    delete_points: {
      args: { collection_name: "docs", filter: FILTER },
      request: { method: "POST", url: `${BASE}/collections/docs/points/delete`, query: { wait: "true" }, json: { filter: FILTER } },
    },
  },
});
