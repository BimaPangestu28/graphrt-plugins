import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const BASE = "https://webapi.bps.go.id";
const listBody = (items, pages = 1) => ({ status: "OK", "data-availability": "available", data: [{ page: 1, pages, per_page: 10, count: items.length, total: items.length }, items] });
const listCase = (model, args, query = {}) => ({
  args: { domain: "3273", ...args },
  request: { method: "GET", url: `${BASE}/v1/api/list/model/${model}/domain/3273`, query: Object.keys(query).length ? query : "absent" },
  response: { body: listBody([{ id: 1 }]) },
  expect: { data: [{ id: 1 }] },
});
const viewCase = (model, itemId) => ({
  args: { domain: "0000", lang: "eng", item_id: itemId },
  request: { method: "GET", url: `${BASE}/v1/api/view/domain/0000/model/${model}/lang/eng/id/${itemId}`, query: "absent" },
  response: { body: { status: "OK", "data-availability": "available", data: { title: "T" } } },
  expect: { data: { title: "T" } },
});

describeRestPluginContract(pluginDefinition, {
  operations: {
    list_domains: {
      args: { domain_type: "kabbyprov", province: "3200" },
      request: { method: "GET", url: `${BASE}/v1/api/domain/type/kabbyprov`, query: { prov: "3200" } },
      response: { body: listBody([{ domain_id: "3273", domain_name: "Kota Bandung" }]) },
      expect: { data: [{ domain_id: "3273", domain_name: "Kota Bandung" }] },
    },
    list_subject_categories: listCase("subcat", { lang: "eng" }, { lang: "eng" }),
    list_subjects: listCase("subject", { subject_category: 1 }, { subcat: "1" }),
    list_variables: listCase("var", { subject: 40, year: 2024, own_domain_only: 1, vertical_variable: 7 }, { subject: "40", year: "2024", area: "1", vervar: "7" }),
    list_vertical_variables: listCase("vervar", { variable: 145 }, { var: "145" }),
    list_derived_variables: listCase("turvar", { variable: 145, group: 0 }, { var: "145", group: "0" }),
    list_periods: listCase("th", { variable: 145 }, { var: "145" }),
    list_derived_periods: listCase("turth", { variable: 145 }, { var: "145" }),
    list_units: listCase("unit", {}),
    get_dynamic_data: {
      args: { domain: "0000", variable: 145, periods: "120:124", derived_variable: 289, vertical_variable: 9999, derived_periods: "0" },
      request: { method: "GET", url: `${BASE}/v1/api/list/model/data/domain/0000/var/145/th/120%3A124`, query: { turvar: "289", vervar: "9999", turth: "0" } },
      response: { body: { status: "OK", datacontent: { "99991452891240": 99.1 } } },
      expect: { data: { status: "OK", datacontent: { "99991452891240": 99.1 } } },
    },
    list_static_tables: listCase("statictable", { keyword: "inflasi", year: 2025, month: 3, lang: "ind" }, { keyword: "inflasi", year: "2025", month: "3", lang: "ind" }),
    get_static_table: viewCase("statictable", 111),
    list_strategic_indicators: listCase("indicators", { variable: 1 }, { var: "1" }),
    get_foreign_trade: {
      args: { trade_flow: 1, period_type: 2, hs_codes: "03;04", hs_code_type: 1, year: 2024 },
      request: { method: "GET", url: `${BASE}/v1/api/dataexim/sumber/1/periode/2/kodehs/03%3B04/jenishs/1/tahun/2024`, query: "absent" },
      response: { body: { status: "OK", data: [{ value: 1015060.142, ctr: "ALBANIA" }] } },
      expect: { data: [{ value: 1015060.142, ctr: "ALBANIA" }] },
    },
    list_press_releases: listCase("pressrelease", { year: 2026 }, { year: "2026" }),
    get_press_release: viewCase("pressrelease", "brs-2399"),
    list_publications: listCase("publication", { keyword: "statistik+indonesia" }, { keyword: "statistik+indonesia" }),
    get_publication: viewCase("publication", "pub-1"),
    search_content: {
      args: { domain: "0000", content_type: "publication", keyword: "inflasi", from_date: "2026-01-01", to_date: "2026-06-30", limit: 20 },
      request: { method: "GET", url: `${BASE}/v1/searching/content/domain/0000/model/publication`, query: { keyword: "inflasi", from: "2026-01-01", to: "2026-06-30", page: "1", perpage: "20" } },
      response: { body: listBody([{ title: "Inflasi" }]) },
      expect: { data: [{ title: "Inflasi" }] },
    },
    list_glossary: {
      args: { prefix: "a" },
      request: { method: "GET", url: `${BASE}/v1/api/list/model/glosarium`, query: { prefix: "a" } },
      response: { body: listBody([{ _source: { konsep: "Agama" } }]) },
      expect: { data: [{ _source: { konsep: "Agama" } }] },
    },
    list_classifications: {
      args: { classification: "kbli2020", level: "kategori", limit: 50 },
      request: { method: "GET", url: `${BASE}/v1/api/list/model/kbli2020`, query: { level: "kategori", perpage: "50" } },
      response: { body: listBody([{ _id: "kbli_2020_01" }]) },
      expect: { data: [{ _id: "kbli_2020_01" }] },
    },
  },
});

async function runTool(operationName, args, responses) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { BPS_API_KEY: "bps-test-key" }, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source: "tool" }), calls: recordingFetch.calls };
}

test("the key goes in the query string, never into the path", async () => {
  const { calls } = await runTool("list_units", { domain: "0000" }, [{ body: listBody([]) }]);
  assert.equal(calls[0].query.key, "bps-test-key");
  assert.equal(calls[0].path.includes("bps-test-key"), false);
});

test("an invalid key (401 KEY_MISSING) is an auth_error with BPS's message", async () => {
  await assert.rejects(
    runTool("list_units", { domain: "0000" }, [{ status: 401, body: { status: "Error", code: "KEY_MISSING", message: "Invalid API KEY" } }]),
    (error) => error.kind === "auth_error" && error.message.includes("Invalid API KEY") && !error.message.includes("bps-test-key"),
  );
});

test("a bad domain id (400) is invalid_input", async () => {
  const message = "'domain' parameter is required and must be a 4-digit numeric string.";
  await assert.rejects(runTool("list_units", { domain: "00000" }, [{ status: 400, body: { status: "Error", message } }]), (error) => error.kind === "invalid_input" && error.message.includes("4-digit"));
});

test("next_cursor walks pages until data.0.pages", async () => {
  const first = await runTool("list_subjects", { domain: "0000" }, [{ body: listBody([{ sub_id: 1 }], 2) }]);
  assert.ok(first.result.next_cursor);
  const second = await runTool("list_subjects", { domain: "0000", cursor: first.result.next_cursor }, [{ body: { ...listBody([{ sub_id: 2 }], 2), data: [{ page: 2, pages: 2 }, [{ sub_id: 2 }]] } }]);
  assert.equal(second.calls[0].query.page, "2");
  assert.equal(second.result.next_cursor, null);
});

test("every operation is a read offered to agents", () => {
  assert.ok(pluginDefinition.operations.every((operation) => !operation.nodeOnly));
  assert.ok(pluginDefinition.restSpec.operations.every((operation) => operation.method === "GET"));
});
