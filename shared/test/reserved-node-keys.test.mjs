import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDescriptors, buildManifest, createOperationRunner } from "../lib/operations.mjs";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";
import { assertNoReservedParameters, isReservedNodeKey, RESERVED_NODE_KEYS } from "../lib/reserved-node-keys.mjs";

const definitionWithParameter = (parameterName) => ({
  name: "demo",
  version: "0",
  description: "d",
  tokenEnv: "DEMO_ACCESS_TOKEN",
  createClient: () => ({}),
  operations: [
    {
      name: "add_sheet",
      title: "Add sheet",
      description: "Add a sheet",
      parameters: { type: "object", properties: { spreadsheet_id: { type: "string" }, [parameterName]: { type: "string" } } },
      run: async () => ({ data: null }),
    },
  ],
});

const restSpecWithParameter = (parameterName, parameterSpec = { in: "query", type: "string" }) => ({
  name: "demo-api",
  version: "0.1.0",
  description: "Demo API",
  baseUrl: "https://api.example.com/v1",
  auth: { type: "bearer", env: "DEMO_TOKEN" },
  operations: [
    { name: "list_items", title: "List items", description: "List items", path: "/items", params: { [parameterName]: parameterSpec } },
  ],
});

test("the reserved list mirrors the keys graphrt-core dsl.rs takes from a node", () => {
  for (const nodeKey of ["id", "type", "title", "parent", "parentId", "data", "retry", "timeout", "timeout_ms", "error_strategy", "default_value", "width", "height"]) {
    assert.equal(isReservedNodeKey(nodeKey), true, nodeKey);
  }
  for (const ordinaryKey of ["sheet_title", "record_type", "query", "limit", "access_token", "Title"]) {
    assert.equal(isReservedNodeKey(ordinaryKey), false, ordinaryKey);
  }
  assert.equal(Object.isFrozen(RESERVED_NODE_KEYS), true);
});

// Every reserved key must be refused, not just the common ones.
for (const reservedKey of RESERVED_NODE_KEYS) {
  test(`hand-written: buildDescriptors refuses a parameter named \`${reservedKey}\``, () => {
    assert.throws(() => buildDescriptors(definitionWithParameter(reservedKey)), (error) => {
      assert.match(error.message, new RegExp(`demo: operation \`add_sheet\`: parameter \`${reservedKey}\` is reserved by graphrt`));
      assert.match(error.message, /rename it/);
      return true;
    });
  });

  test(`declarative: defineRestPlugin refuses a param named \`${reservedKey}\` and suggests wireName`, () => {
    assert.throws(() => defineRestPlugin(restSpecWithParameter(reservedKey)), (error) => {
      assert.match(error.message, new RegExp(`operation \`list_items\`: param \`${reservedKey}\`: .*reserved by graphrt`));
      assert.match(error.message, new RegExp(`wireName: "${reservedKey}"`));
      return true;
    });
  });
}

test("hand-written: the runner and the manifest refuse reserved parameters too", () => {
  assert.throws(() => createOperationRunner(definitionWithParameter("title"), {}), /parameter `title` is reserved/);
  assert.throws(() => buildManifest(definitionWithParameter("type")), /parameter `type` is reserved/);
});

test("assertNoReservedParameters accepts ordinary names and operations without parameters", () => {
  assert.doesNotThrow(() => assertNoReservedParameters(definitionWithParameter("sheet_title")));
  const withoutParameters = { name: "demo", operations: [{ name: "ping", run: async () => ({}) }] };
  assert.doesNotThrow(() => assertNoReservedParameters(withoutParameters));
});

test("declarative: a renamed param keeps the reserved word as its wireName", async () => {
  const pluginDefinition = defineRestPlugin(restSpecWithParameter("item_type", { in: "query", type: "string", wireName: "type" }));
  const requestedUrls = [];
  const fetchImpl = async (url) => (requestedUrls.push(String(url)), new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  const runOperation = createOperationRunner(pluginDefinition, { DEMO_TOKEN: "t" }, { fetchImpl });
  await runOperation("list_items", { item_type: "book" }, { source: "node" });
  assert.equal(new URL(requestedUrls[0]).searchParams.get("type"), "book");
});
