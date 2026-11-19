import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const SERVER = "https://abc123.c0.europe-west3.gcp.weaviate.cloud";
const API_KEY = "contract-weaviate-key-0001";
const OBJECT_ID = "36ddd591-2dee-4e7e-a3cc-eb86d30a4303";

describeRestPluginContract(pluginDefinition, {
  environment: { WEAVIATE_URL: SERVER, WEAVIATE_API_KEY: API_KEY },
  checkAuth: (call) => assert.equal(call.headers.authorization, `Bearer ${API_KEY}`),
  operations: {
    get_meta: {
      args: {},
      request: { method: "GET", url: `${SERVER}/v1/meta`, query: "absent" },
      response: { body: { version: "1.40.5", modules: {} } },
      expect: { data: { version: "1.40.5", modules: {} } },
    },
    list_collections: {
      args: {},
      request: { method: "GET", url: `${SERVER}/v1/schema`, query: "absent" },
      response: { body: { classes: [{ class: "Article" }] } },
      expect: { data: [{ class: "Article" }] },
    },
    get_collection: {
      args: { collection: "Article" },
      request: { method: "GET", url: `${SERVER}/v1/schema/Article`, query: "absent" },
    },
    get_nodes_status: {
      args: {},
      request: { method: "GET", url: `${SERVER}/v1/nodes`, query: { output: "verbose" } },
    },
    list_objects: {
      args: { collection: "Article", include: "vector", limit: 2 },
      request: { method: "GET", url: `${SERVER}/v1/objects`, query: { class: "Article", include: "vector", limit: "2" } },
      response: { body: { objects: [{ id: OBJECT_ID, properties: { title: "A" } }] } },
      expect: { data: [{ id: OBJECT_ID, properties: { title: "A" } }] },
    },
    get_object: {
      args: { collection: "Article", object_id: OBJECT_ID, tenant: "tenantA", consistency_level: "QUORUM" },
      request: { method: "GET", url: `${SERVER}/v1/objects/Article/${OBJECT_ID}`, query: { tenant: "tenantA", consistency_level: "QUORUM" } },
    },
    create_object: {
      args: { collection: "Article", properties: { title: "Hello" }, object_uuid: OBJECT_ID, vector: [0.1, 0.2] },
      request: { method: "POST", url: `${SERVER}/v1/objects`, query: "absent", json: { class: "Article", properties: { title: "Hello" }, id: OBJECT_ID, vector: [0.1, 0.2] } },
    },
    update_object: {
      args: { collection: "Article", object_id: OBJECT_ID, properties: { title: "Hi" } },
      request: { method: "PATCH", url: `${SERVER}/v1/objects/Article/${OBJECT_ID}`, query: "absent", json: { properties: { title: "Hi" } } },
    },
    batch_objects: {
      args: { objects: [{ class: "Article", properties: { title: "A" } }] },
      request: { method: "POST", url: `${SERVER}/v1/batch/objects`, query: "absent", json: { objects: [{ class: "Article", properties: { title: "A" } }] } },
    },
    delete_object: {
      args: { collection: "Article", object_id: OBJECT_ID },
      request: { method: "DELETE", url: `${SERVER}/v1/objects/Article/${OBJECT_ID}`, query: "absent", body: "absent" },
    },
    graphql_query: {
      args: { query: "{ Get { Article(limit: 1) { title } } }" },
      request: { method: "POST", url: `${SERVER}/v1/graphql`, query: "absent", json: { query: "{ Get { Article(limit: 1) { title } } }" } },
    },
  },
});
