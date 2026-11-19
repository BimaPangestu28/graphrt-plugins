import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { isToolReadPath } from "../lib/tool-path-allowlist.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENVIRONMENT = { LAZADA_APP_KEY: "123456", LAZADA_APP_SECRET: "app-secret-for-tests", LAZADA_ACCESS_TOKEN: "seller-access-token", LAZADA_REGION: "id" };

async function run(operationName, args, { source = "tool", body = { code: "0", data: {} } } = {}) {
  const recordingFetch = createRecordingFetch([{ body }]);
  const runner = createOperationRunner(pluginDefinition, ENVIRONMENT, { fetchImpl: recordingFetch });
  return { output: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("api_request as a tool only reaches read paths (signed GETs to write APIs are refused)", async () => {
  for (const path of ["/order/cancel", "/order/fulfill/pack", "/product/price_quantity/update", "/auth/token/create", "/auth/token/refresh", "/finance/payout/create", "/seller/update", "/Order/Cancel"]) {
    await assert.rejects(run("api_request", { path }), (error) => error.kind === "permission_denied" && error.message.includes("api_request cannot reach"), path);
  }
  for (const path of ["/seller/get", "/orders/get", "/Orders/Items/Get", "/finance/transaction/details/get"]) {
    const { calls } = await run("api_request", { path });
    assert.equal(calls.length, 1, path);
  }
  const { calls } = await run("api_request", { path: "/order/cancel" }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("isToolReadPath refuses odd paths before matching", () => {
  for (const path of ["/orders/get?x=1", "/orders/get#a", "/orders/%67et", "/orders/../order/cancel", "/finance/./get", "\\orders\\get", undefined, 7]) {
    assert.equal(isToolReadPath(path), false, String(path));
  }
  assert.equal(isToolReadPath("/orders/get/"), true);
});

test("named operations redact a secret echoed in a 200 body", async () => {
  const { output } = await run("get_seller", {}, { body: { code: "0", data: { note: "token seller-access-token secret app-secret-for-tests" } } });
  assert.equal(JSON.stringify(output.data).includes("seller-access-token"), false);
  assert.equal(JSON.stringify(output.data).includes("app-secret-for-tests"), false);
});
