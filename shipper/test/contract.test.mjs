import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, resolveShipperUrl, restDefinition } from "../definition.mjs";

const API = "https://merchant-api.shipper.id";
const origin = { area_id: 4711, lat: "-6.2", lng: "106.8", suburb_id: 482 };
const destination = { area_id: 12345, lat: "-6.9", lng: "107.6", suburb_id: 1030 };
const parcel = { weight: 1, length: 10, width: 10, height: 5, item_value: 150000 };
const parcelArgs = { weight: 1, package_length: 10, package_width: 10, package_height: 5, item_value: 150000 };

describeRestPluginContract(restDefinition, {
  operations: {
    search_locations: {
      args: { keyword: "Kebayoran", adm_level: 5, limit: 5 },
      request: { method: "GET", url: `${API}/v3/location`, query: { keyword: "Kebayoran", adm_level: "5", limit: "5" } },
      response: { body: { data: [{ display_txt: "Gandaria Utara, Kebayoran Baru, Jakarta Selatan" }] } },
      expect: { data: [{ display_txt: "Gandaria Utara, Kebayoran Baru, Jakarta Selatan" }] },
    },
    list_countries: {
      args: {},
      request: { method: "GET", url: `${API}/v3/location/countries`, query: { limit: "50" } },
    },
    list_provinces: {
      args: { country_id: "228" },
      request: { method: "GET", url: `${API}/v3/location/country/228/provinces`, query: { limit: "50" } },
    },
    list_cities: {
      args: { province_id: "6", limit: 100 },
      request: { method: "GET", url: `${API}/v3/location/province/6/cities`, query: { limit: "100" } },
    },
    list_suburbs: {
      args: { city_id: "41" },
      request: { method: "GET", url: `${API}/v3/location/city/41/suburbs`, query: { limit: "50" } },
    },
    list_areas: {
      args: { suburb_id: "482" },
      request: { method: "GET", url: `${API}/v3/location/suburb/482/areas`, query: { limit: "50" } },
    },
    get_domestic_rates: {
      args: { origin, destination, ...parcelArgs, item_categories: ["Pakaian"], cod_amount: 150000, rate_types: ["regular", "express"] },
      request: {
        method: "POST",
        url: `${API}/v3/pricing/domestic`,
        query: "absent",
        json: { origin, destination, ...parcel, item_categories: ["Pakaian"], for_order: true, cod_amount: 150000, rate_type: ["regular", "express"] },
      },
      response: { body: { data: { pricings: [{ rate: { id: 58, name: "Reguler" }, final_price: 18000 }] } } },
      expect: { data: { pricings: [{ rate: { id: 58, name: "Reguler" }, final_price: 18000 }] } },
    },
    create_order: {
      args: {
        consignee: { name: "Budi", phone_number: "6281200000002", email: "budi@example.com" },
        consigner: { name: "Toko A", phone_number: "6281200000001", email: "toko@example.com" },
        courier: { rate_id: 58, use_insurance: false, cod: false },
        origin: { area_id: 4711, address: "Jl. Sudirman 1" },
        destination: { area_id: 12345, address: "Jl. Asia Afrika 2" },
        package: { weight: 1, length: 10, width: 10, height: 5, price: 150000, package_type: 2, items: [{ name: "Kemeja", price: 150000, qty: 1 }] },
        external_id: "INV-1",
      },
      request: {
        method: "POST",
        url: `${API}/v3/order`,
        query: "absent",
        json: {
          consignee: { name: "Budi", phone_number: "6281200000002", email: "budi@example.com" },
          consigner: { name: "Toko A", phone_number: "6281200000001", email: "toko@example.com" },
          coverage: "domestic",
          courier: { rate_id: 58, use_insurance: false, cod: false },
          origin: { area_id: 4711, address: "Jl. Sudirman 1" },
          destination: { area_id: 12345, address: "Jl. Asia Afrika 2" },
          package: { weight: 1, length: 10, width: 10, height: 5, price: 150000, package_type: 2, items: [{ name: "Kemeja", price: 150000, qty: 1 }] },
          external_id: "INV-1",
          payment_type: "postpay",
        },
      },
    },
    get_order: {
      args: { order_id: "22ABCD" },
      request: { method: "GET", url: `${API}/v3/order/22ABCD`, query: "absent" },
    },
    get_order_by_external_id: {
      args: { external_id: "INV/1" },
      request: { method: "GET", url: `${API}/v3/order/external-id/INV%2F1`, query: "absent" },
    },
    cancel_order: {
      args: { order_id: "22ABCD", reason: "Customer cancelled" },
      request: { method: "DELETE", url: `${API}/v3/order/22ABCD`, query: "absent", json: { reason: "Customer cancelled" } },
    },
    request_pickup: {
      args: { order_ids: ["22ABCD"], pickup_time: "2026-11-20T10:00:00+07:00" },
      request: { method: "POST", url: `${API}/v3/pickup`, query: "absent", json: { data: { order_activation: { order_id: ["22ABCD"], pickup_time: "2026-11-20T10:00:00+07:00" } } } },
    },
    create_label: {
      args: { order_ids: ["22ABCD"] },
      request: { method: "POST", url: `${API}/v3/order/label`, query: "absent", json: { id: ["22ABCD"], type: "LBL" } },
    },
  },
});

function createRunner(responses, environment = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { SHIPPER_API_KEY: "shipper-key-0001", ...environment }, { fetchImpl: recordingFetch });
  return { run, calls: recordingFetch.calls };
}

test("SHIPPER_ENVIRONMENT=sandbox uses the sandbox host; unknown values are refused", async () => {
  const { run, calls } = createRunner([{ body: { data: [] } }], { SHIPPER_ENVIRONMENT: "sandbox" });
  await run("search_locations", { keyword: "Bandung" }, { source: "tool" });
  assert.equal(new URL(calls[0].url).origin, "https://merchant-api-sandbox.shipper.id");
  assert.equal(calls[0].headers["x-api-key"], "shipper-key-0001");
  assert.throws(() => resolveShipperUrl({ SHIPPER_ENVIRONMENT: "staging" }), /production or sandbox/);
});

test("orders, cancellations and pickups are node only", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["create_order", "cancel_order", "request_pickup"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.ok(toolNames.includes("get_domestic_rates"));
});

test("an invalid key (403, code 70002) is an auth_error with Shipper's message", async () => {
  const body = { metadata: { path: "/v3/location", http_status_code: 403, http_status: "Forbidden", errors: [{ code: 70002, message: "Unauthorized Access. You are not authorized to access this resource." }] } };
  const { run } = createRunner([{ status: 403, body }]);
  await assert.rejects(run("search_locations", { keyword: "Bandung" }, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Unauthorized Access"));
});

test("location lists page with page/limit and stop at total_pages", async () => {
  const { run } = createRunner([{ body: { data: [{ city_id: 1 }], pagination: { current_page: 1, total_pages: 2 } } }]);
  const firstPage = await run("list_cities", { province_id: "6" }, { source: "tool" });
  assert.ok(firstPage.next_cursor);
  const { run: runLast } = createRunner([{ body: { data: [{ city_id: 2 }], pagination: { current_page: 2, total_pages: 2 } } }]);
  const lastPage = await runLast("list_cities", { province_id: "6", cursor: firstPage.next_cursor }, { source: "tool" });
  assert.equal(lastPage.next_cursor, null);
});

test("get_domestic_rates checks item_categories against Shipper's list, needs a weight above 0, and has no cod flag", async () => {
  const { run, calls } = createRunner([]);
  const rateArgs = { origin, destination, ...parcelArgs, item_categories: ["Pakaian"] };
  const refuses = (args) => assert.rejects(run("get_domestic_rates", args, { source: "tool" }), (error) => error.kind === "invalid_input");
  await refuses({ ...rateArgs, item_categories: ["Clothes"] });
  await refuses({ ...rateArgs, weight: 0 });
  assert.equal(calls.length, 0);
  const rateProperties = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "get_domestic_rates").parameters.properties;
  assert.equal("cod" in rateProperties, false);
  assert.ok(rateProperties.item_categories.items.enum.includes("Lainnya"));
});

test("pickups and labels take at most 30 orders", () => {
  const nodes = buildManifest(pluginDefinition).nodes;
  for (const kind of ["shipper.request_pickup", "shipper.create_label"]) {
    assert.equal(nodes.find((node) => node.kind === kind).config_schema.properties.order_ids.maxItems, 30, kind);
  }
});

test("item categories are matched case-insensitively and sent in Shipper's spelling", async () => {
  const { run, calls } = createRunner([{ body: { data: { pricings: [] } } }]);
  await run("get_domestic_rates", { origin, destination, ...parcelArgs, item_categories: ["pakaian", "spare parts"] }, { source: "tool" });
  assert.deepEqual(JSON.parse(calls[0].body).item_categories, ["Pakaian", "Spare Parts"]);
});

test("item_categories is optional and left out of the request when not given", async () => {
  const { run, calls } = createRunner([{ body: { data: { pricings: [] } } }]);
  await run("get_domestic_rates", { origin, destination, ...parcelArgs }, { source: "tool" });
  assert.equal("item_categories" in JSON.parse(calls[0].body), false);
  const rateSchema = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "get_domestic_rates").parameters;
  assert.equal(rateSchema.required.includes("item_categories"), false);
});
