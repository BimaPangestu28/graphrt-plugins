import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const environment = { WOOCOMMERCE_SITE_URL: "https://shop.example.com", WOOCOMMERCE_CONSUMER_KEY: "ck_fake", WOOCOMMERCE_CONSUMER_SECRET: "cs_fake" };

async function run(args, source = "tool") {
  const recordingFetch = createRecordingFetch([{ body: [] }]);
  const runner = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  return { result: await runner("api_request", args, { source }), calls: recordingFetch.calls };
}

const isDenied = (error) => error.kind === "permission_denied" && error.message.includes("api_request");

test("tools cannot put a query string in the path (WordPress _method / rest_route overrides)", async () => {
  const refusedPaths = [
    "/orders/42/refunds?_method=POST&amount=10",
    "/products/7?_method=PUT&regular_price=0.01",
    "/products/7?_method=DELETE&force=true",
    "/products?.method=POST",
    "/products?rest_route=/wc/v3/webhooks",
    "/products%3F_method=DELETE",
    "/products%253F_method=DELETE",
    "/products#x",
  ];
  for (const path of refusedPaths) {
    const recordingFetch = createRecordingFetch([{ body: [] }]);
    const runner = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
    await assert.rejects(runner("api_request", { path }, { source: "tool" }), isDenied, path);
    assert.equal(recordingFetch.calls.length, 0, path);
  }
});

test("tools may only use allowlisted query keys", async () => {
  for (const key of ["_method", ".method", " method", "[method", "rest_route", "_envelope", "_fields", "force", "regular_price", "amount"]) {
    await assert.rejects(run({ path: "/products", query: { [key]: "POST" } }), isDenied, key);
  }
  const { calls } = await run({ path: "/orders", query: { status: "processing", per_page: 5, page: 2, after: "2026-11-01T00:00:00" } });
  assert.deepEqual(calls[0].query, { status: "processing", per_page: "5", page: "2", after: "2026-11-01T00:00:00" });
});

test("workflow nodes keep full api_request", async () => {
  const { calls } = await run({ path: "/products", query: { _fields: "id,name" } }, "node");
  assert.equal(calls[0].query._fields, "id,name");
});
