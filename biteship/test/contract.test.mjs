import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://api.biteship.com";
const items = [{ name: "Kemeja", value: 150000, quantity: 1, weight: 300 }];
const parties = {
  origin_contact_name: "Toko A",
  origin_contact_phone: "08120000001",
  origin_address: "Jl. Sudirman 1, Jakarta",
  origin_postal_code: 10220,
  destination_contact_name: "Budi",
  destination_contact_phone: "08120000002",
  destination_address: "Jl. Asia Afrika 2, Bandung",
  destination_postal_code: 40111,
};

describeRestPluginContract(pluginDefinition, {
  operations: {
    get_rates: {
      args: { origin_postal_code: 12440, destination_postal_code: 40111, couriers: "jne,sicepat", items },
      request: { method: "POST", url: `${API}/v1/rates/couriers`, query: "absent", json: { origin_postal_code: 12440, destination_postal_code: 40111, couriers: "jne,sicepat", items } },
      response: { body: { success: true, pricing: [{ courier_code: "jne", courier_service_code: "reg", price: 18000 }] } },
      expect: { data: [{ courier_code: "jne", courier_service_code: "reg", price: 18000 }] },
    },
    list_couriers: {
      args: {},
      request: { method: "GET", url: `${API}/v1/couriers`, query: "absent" },
      response: { body: { success: true, object: "courier", couriers: [{ courier_code: "jne" }] } },
      expect: { data: [{ courier_code: "jne" }] },
    },
    search_areas: {
      args: { input: "Kebayoran Baru" },
      request: { method: "GET", url: `${API}/v1/maps/areas`, query: { input: "Kebayoran Baru", countries: "ID", type: "single" } },
      response: { body: { success: true, areas: [{ id: "IDNP6IDNC148", name: "Kebayoran Baru, Jakarta Selatan" }] } },
      expect: { data: [{ id: "IDNP6IDNC148", name: "Kebayoran Baru, Jakarta Selatan" }] },
    },
    create_order: {
      args: { ...parties, courier_company: "jne", courier_type: "reg", delivery_type: "now", reference_id: "INV-1", items },
      request: { method: "POST", url: `${API}/v1/orders`, query: "absent", json: { ...parties, courier_company: "jne", courier_type: "reg", delivery_type: "now", reference_id: "INV-1", items } },
    },
    get_order: {
      args: { order_id: "5dd599ebdefcd4158eb8470b" },
      request: { method: "GET", url: `${API}/v1/orders/5dd599ebdefcd4158eb8470b`, query: "absent" },
    },
    cancel_order: {
      args: { order_id: "o1", cancellation_reason_code: "others", cancellation_reason: "Customer changed address" },
      request: { method: "POST", url: `${API}/v1/orders/o1/cancel`, query: "absent", json: { cancellation_reason_code: "others", cancellation_reason: "Customer changed address" } },
    },
    list_cancellation_reasons: {
      args: { lang: "id" },
      request: { method: "GET", url: `${API}/v1/orders/cancellation_reasons`, query: { lang: "id" } },
    },
    get_tracking: {
      args: { tracking_id: "t1" },
      request: { method: "GET", url: `${API}/v1/trackings/t1`, query: "absent" },
    },
    track_waybill: {
      args: { waybill_id: "JT0001", courier_code: "jnt" },
      request: { method: "GET", url: `${API}/v1/trackings/JT0001/couriers/jnt`, query: "absent" },
    },
  },
});

function createRunner(responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { BITESHIP_API_KEY: "biteship_test.key0001" }, { fetchImpl: recordingFetch });
  return { run, calls: recordingFetch.calls };
}

test("the key is the Authorization header as is", async () => {
  const { run, calls } = createRunner([{ body: { success: true, couriers: [] } }]);
  await run("list_couriers", {}, { source: "tool" });
  assert.equal(calls[0].headers.authorization, "biteship_test.key0001");
});

test("bookings and cancellations are node only", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("create_order"), false);
  assert.equal(toolNames.includes("cancel_order"), false);
  assert.ok(toolNames.includes("get_rates"));
});

test("Biteship {success: false, error, code} errors map to kinds", async () => {
  const { run } = createRunner([{ status: 400, body: { success: false, error: "Authentication for your key has failed", code: 40000001 } }]);
  await assert.rejects(run("list_couriers", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Authentication for your key has failed"));
  const { run: runQuota } = createRunner([{ status: 402, body: { success: false, error: "Insufficient balance", code: 40200000 } }]);
  await assert.rejects(runQuota("get_rates", { origin_postal_code: 1, destination_postal_code: 2, couriers: "jne", items }, { source: "tool" }), (error) => error.kind === "permission_denied");
});

test("a rate check is not retried after a 5xx", async () => {
  const { run, calls } = createRunner([{ status: 502, body: {} }, { body: { pricing: [] } }]);
  await assert.rejects(run("get_rates", { origin_postal_code: 1, destination_postal_code: 2, couriers: "jne", items }, { source: "tool" }), (error) => error.retryable === false);
  assert.equal(calls.length, 1);
});
