import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, restDefinition } from "../definition.mjs";

const API = "https://rajaongkir.komerce.id/api/v1";
const envelope = (data) => ({ meta: { message: "Success", code: 200, status: "success" }, data });

describeRestPluginContract(restDefinition, {
  operations: {
    search_domestic_destinations: {
      args: { search: "coblong", limit: 5 },
      request: { method: "GET", url: `${API}/destination/domestic-destination`, query: { search: "coblong", limit: "5" } },
      response: { body: envelope([{ id: 17473, label: "DAGO, COBLONG, BANDUNG, JAWA BARAT, 40135" }]) },
      expect: { data: [{ id: 17473, label: "DAGO, COBLONG, BANDUNG, JAWA BARAT, 40135" }] },
    },
    search_international_destinations: {
      args: { search: "malaysia" },
      request: { method: "GET", url: `${API}/destination/international-destination`, query: { search: "malaysia", limit: "10" } },
    },
    list_provinces: {
      args: {},
      request: { method: "GET", url: `${API}/destination/province`, query: "absent" },
      response: { body: envelope([{ id: 1, name: "BALI" }]) },
      expect: { data: [{ id: 1, name: "BALI" }] },
    },
    list_cities: {
      args: { province_id: "9" },
      request: { method: "GET", url: `${API}/destination/city/9`, query: "absent" },
    },
    list_districts: {
      args: { city_id: "55" },
      request: { method: "GET", url: `${API}/destination/district/55`, query: "absent" },
    },
    list_subdistricts: {
      args: { district_id: "1360" },
      request: { method: "GET", url: `${API}/destination/sub-district/1360`, query: "absent" },
    },
    calculate_domestic_cost: {
      args: { origin: "17473", destination: "31555", weight: 1000, courier: "jne:sicepat:jnt", price: "lowest" },
      request: { method: "POST", url: `${API}/calculate/domestic-cost`, query: "absent", form: { origin: "17473", destination: "31555", weight: "1000", courier: "jne:sicepat:jnt", price: "lowest" } },
      response: { body: envelope([{ name: "Jalur Nugraha Ekakurir (JNE)", code: "jne", service: "REG", cost: 18000, etd: "1-2 day" }]) },
      expect: { data: [{ name: "Jalur Nugraha Ekakurir (JNE)", code: "jne", service: "REG", cost: 18000, etd: "1-2 day" }] },
    },
    calculate_district_cost: {
      args: { origin: "1360", destination: "1391", weight: 500, courier: "jne" },
      request: { method: "POST", url: `${API}/calculate/district/domestic-cost`, query: "absent", form: { origin: "1360", destination: "1391", weight: "500", courier: "jne" } },
    },
    calculate_international_cost: {
      args: { origin: "17473", destination: "108", weight: 1500, courier: "pos:jne" },
      request: { method: "POST", url: `${API}/calculate/international-cost`, query: "absent", form: { origin: "17473", destination: "108", weight: "1500", courier: "pos:jne" } },
    },
    track_waybill: {
      args: { awb: "JP0001", courier: "jne", last_phone_number: "12345" },
      request: { method: "POST", url: `${API}/track/waybill`, query: { awb: "JP0001", courier: "jne" }, form: { last_phone_number: "12345" } },
      response: { body: envelope({ delivered: true, summary: { waybill_number: "JP0001", status: "DELIVERED" } }) },
      expect: { data: { delivered: true, summary: { waybill_number: "JP0001", status: "DELIVERED" } } },
    },
  },
});

function createRunner(responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { RAJAONGKIR_API_KEY: "ro-key-0001" }, { fetchImpl: recordingFetch });
  return { run, calls: recordingFetch.calls };
}

test("the key is sent in the `key` header", async () => {
  const { run, calls } = createRunner([{ body: envelope([]) }]);
  await run("list_provinces", {}, { source: "tool" });
  assert.equal(calls[0].headers.key, "ro-key-0001");
});

test("an invalid key (HTTP 400 'Invalid Api key') is an auth_error, other 400s stay invalid_input", async () => {
  const invalidKey = { status: 400, body: { meta: { message: "Invalid Api key, key not found", code: 400, status: "failed" }, data: null } };
  const { run } = createRunner([invalidKey]);
  await assert.rejects(run("list_provinces", {}, { source: "tool" }), (error) => error.kind === "auth_error" && error.message.includes("Invalid Api key"));
  const missing = { status: 400, body: { meta: { message: "Missing required parameter: weight", code: 400, status: "failed" }, data: null } };
  const { run: runMissing } = createRunner([missing]);
  await assert.rejects(runMissing("calculate_domestic_cost", { origin: "1", destination: "2", weight: 1, courier: "jne" }, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("a waybill that is not found is not_found with RajaOngkir's message", async () => {
  const { run } = createRunner([{ status: 404, body: { meta: { message: "Invalid waybill. Data not found", code: 404, status: "failed" }, data: null } }]);
  await assert.rejects(run("track_waybill", { awb: "X", courier: "jne" }, { source: "tool" }), (error) => error.kind === "not_found" && error.message.includes("Data not found"));
});

test("weights must be positive grams", async () => {
  const { run, calls } = createRunner([]);
  await assert.rejects(run("calculate_domestic_cost", { origin: "1", destination: "2", weight: 0, courier: "jne" }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(calls.length, 0);
});
