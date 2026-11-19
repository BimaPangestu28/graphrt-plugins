import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const HOST = "https://docs-example-a1b2c3d.svc.aped-4627-b74a.pinecone.io";
const CONTROL = "https://api.pinecone.io";
const FILTER = { genre: { $eq: "drama" } };

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool; the extra-paths env lets that path through.
  environment: { PINECONE_INDEX_HOST: "docs-example-a1b2c3d.svc.aped-4627-b74a.pinecone.io", PINECONE_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    list_indexes: {
      args: {},
      request: { method: "GET", url: `${CONTROL}/indexes`, query: "absent" },
      response: { body: { indexes: [{ name: "docs-example", host: "docs-example-a1b2c3d.svc.aped-4627-b74a.pinecone.io" }] } },
      expect: { data: [{ name: "docs-example", host: "docs-example-a1b2c3d.svc.aped-4627-b74a.pinecone.io" }] },
    },
    describe_index: {
      args: { index_name: "docs-example" },
      request: { method: "GET", url: `${CONTROL}/indexes/docs-example`, query: "absent" },
    },
    delete_index: {
      args: { index_name: "docs-example" },
      request: { method: "DELETE", url: `${CONTROL}/indexes/docs-example`, query: "absent", body: "absent" },
    },
    describe_index_stats: {
      args: {},
      request: { method: "POST", url: `${HOST}/describe_index_stats`, query: "absent", json: {} },
    },
    list_namespaces: {
      args: { prefix: "tenant-", limit: 10 },
      request: { method: "GET", url: `${HOST}/namespaces`, query: { prefix: "tenant-", limit: "10" } },
      response: { body: { namespaces: [{ name: "tenant-a", record_count: "3" }], pagination: { next: "tok2" } } },
      expect: { data: [{ name: "tenant-a", record_count: "3" }] },
    },
    delete_namespace: {
      args: { namespace: "tenant/a" },
      request: { method: "DELETE", url: `${HOST}/namespaces/tenant%2Fa`, query: "absent", body: "absent" },
    },
    query_vectors: {
      args: { top_k: 3, vector: [0.1, 0.2], namespace: "ns1", filter: FILTER },
      request: { method: "POST", url: `${HOST}/query`, query: "absent", json: { topK: 3, vector: [0.1, 0.2], namespace: "ns1", filter: FILTER, includeMetadata: true, includeValues: false } },
    },
    fetch_vectors: {
      args: { ids: ["a", "b"], namespace: "ns1" },
      request: { method: "GET", url: `${HOST}/vectors/fetch`, query: { ids: ["a", "b"], namespace: "ns1" } },
    },
    fetch_vectors_by_metadata: {
      args: { filter: FILTER, namespace: "ns1", limit: 50, cursor: "tok1" },
      request: { method: "POST", url: `${HOST}/vectors/fetch_by_metadata`, query: "absent", json: { filter: FILTER, namespace: "ns1", limit: 50, paginationToken: "tok1" } },
    },
    list_vector_ids: {
      args: { prefix: "doc1#", namespace: "ns1", limit: 100 },
      request: { method: "GET", url: `${HOST}/vectors/list`, query: { prefix: "doc1#", namespace: "ns1", limit: "100" } },
      response: { body: { vectors: [{ id: "doc1#a" }], pagination: { next: "tok2" }, namespace: "ns1" } },
      expect: { data: [{ id: "doc1#a" }] },
    },
    upsert_vectors: {
      args: { vectors: [{ id: "a", values: [0.1, 0.2], metadata: { genre: "drama" } }], namespace: "ns1" },
      request: { method: "POST", url: `${HOST}/vectors/upsert`, query: "absent", json: { vectors: [{ id: "a", values: [0.1, 0.2], metadata: { genre: "drama" } }], namespace: "ns1" } },
    },
    update_vectors: {
      args: { vector_id: "a", set_metadata: { genre: "comedy" }, namespace: "ns1" },
      request: { method: "POST", url: `${HOST}/vectors/update`, query: "absent", json: { id: "a", setMetadata: { genre: "comedy" }, namespace: "ns1" } },
    },
    delete_vectors: {
      args: { ids: ["a"], namespace: "ns1" },
      request: { method: "POST", url: `${HOST}/vectors/delete`, query: "absent", json: { ids: ["a"], namespace: "ns1" } },
    },
    search_documents: {
      args: { namespace: "articles", score_by: [{ type: "embed", fields: ["content"], query: "what is ML?" }], top_k: 5, include_fields: ["title"] },
      request: {
        method: "POST",
        url: `${HOST}/namespaces/articles/documents/search`,
        query: "absent",
        json: { score_by: [{ type: "embed", fields: ["content"], query: "what is ML?" }], top_k: 5, include_fields: ["title"] },
      },
    },
    fetch_documents: {
      args: { namespace: "articles", filter: FILTER, limit: 20 },
      request: { method: "POST", url: `${HOST}/namespaces/articles/documents/fetch`, query: "absent", json: { filter: FILTER, limit: 20 } },
    },
    list_documents: {
      args: { namespace: "articles", prefix: "doc-", cursor: "tok1" },
      request: { method: "POST", url: `${HOST}/namespaces/articles/documents/list`, query: "absent", json: { prefix: "doc-", pagination_token: "tok1" } },
      response: { body: { documents: [{ _id: "doc-1" }], namespace: "articles", usage: {} } },
      expect: { data: [{ _id: "doc-1" }] },
    },
    upsert_documents: {
      args: { namespace: "articles", documents: [{ _id: "doc-1", content: "Machine learning" }] },
      request: { method: "POST", url: `${HOST}/namespaces/articles/documents/upsert`, query: "absent", json: { documents: [{ _id: "doc-1", content: "Machine learning" }] } },
    },
    update_documents: {
      args: { namespace: "articles", filter: FILTER, set_fields: { category: "archive" } },
      request: { method: "POST", url: `${HOST}/namespaces/articles/documents/update`, query: "absent", json: { filter: FILTER, set_fields: { category: "archive" } } },
    },
    delete_documents: {
      args: { namespace: "articles", ids: ["doc-1"] },
      request: { method: "POST", url: `${HOST}/namespaces/articles/documents/delete`, query: "absent", json: { ids: ["doc-1"] } },
    },
    search_records: {
      args: { namespace: "example-namespace", query_text: "Disease prevention", top_k: 4, fields: ["chunk_text"], rerank: { model: "bge-reranker-v2-m3", rank_fields: ["chunk_text"], top_n: 2 } },
      request: {
        method: "POST",
        url: `${HOST}/records/namespaces/example-namespace/search`,
        query: "absent",
        json: { query: { inputs: { text: "Disease prevention" }, top_k: 4 }, fields: ["chunk_text"], rerank: { model: "bge-reranker-v2-m3", rank_fields: ["chunk_text"], top_n: 2 } },
      },
    },
  },
});
