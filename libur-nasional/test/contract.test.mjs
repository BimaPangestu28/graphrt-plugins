import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createTtlCache } from "../lib/holiday-cache.mjs";
import { createPluginDefinition, pluginDefinition } from "../definition.mjs";

const API = "https://api-hari-libur.pages.dev/api";
const YEAR_2026 = [
  { name: "Tahun Baru 2026 Masehi", date: "2026-01-01", is_national_holiday: true },
  { name: "Cuti Bersama Hari Raya Idul Fitri 1447 Hijriyah", date: "2026-03-20", is_national_holiday: false },
  { name: "Hari Raya Idul Fitri 1447 Hijriyah", date: "2026-03-21", is_national_holiday: true },
  { name: "Hari Raya Natal", date: "2026-12-25", is_national_holiday: true },
];
const YEAR_2027 = [{ name: "Tahun Baru 2027 Masehi", date: "2027-01-01", is_national_holiday: true }];
const TOO_LATE = { status: 422, body: { error: true, status: 422, message: "The given data was invalid.", data: { year: ["Maximum year is 2027"] } } };
const NO_CACHE = { LIBUR_NASIONAL_CACHE_TTL_SECONDS: "0" };

describeRestPluginContract(pluginDefinition, {
  environment: NO_CACHE,
  operations: {
    list_holidays: {
      args: { year: 2026, month: 3, kind: "libur_nasional" },
      request: { method: "GET", url: API, query: { year: "2026" } },
      response: { body: YEAR_2026 },
      expect: { data: [{ date: "2026-03-21", name: "Hari Raya Idul Fitri 1447 Hijriyah", is_national_holiday: true, kind: "libur_nasional" }] },
    },
  },
});

function createRunner({ environment = {}, responses, nowIso = "2026-11-19T03:00:00Z" }) {
  const recordingFetch = createRecordingFetch(responses);
  const definition = createPluginDefinition({ cache: createTtlCache(), now: () => Date.parse(nowIso) });
  const runner = createOperationRunner(definition, environment, { fetchImpl: recordingFetch });
  return { run: (operationName, args, source = "tool") => runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("libur-nasional needs no credential; its env is the source URL and the cache TTL", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: true, secrets: false, env: ["LIBUR_NASIONAL_API_URL", "LIBUR_NASIONAL_CACHE_TTL_SECONDS"] });
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["list_holidays", "check_date", "next_holidays", "count_working_days", "api_request"]);
});

test("a year is fetched once and served from the cache for every operation", async () => {
  const { run, calls } = createRunner({ responses: [{ body: YEAR_2026 }] });
  await run("list_holidays", { year: 2026 });
  await run("list_holidays", { year: 2026, month: 12 });
  const checked = await run("check_date", { date: "2026-03-20" });
  assert.equal(checked.data.is_cuti_bersama, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].query, { year: "2026" });
});

test("LIBUR_NASIONAL_CACHE_TTL_SECONDS=0 fetches every time; a bad value is refused", async () => {
  const uncached = createRunner({ environment: NO_CACHE, responses: [{ body: YEAR_2026 }, { body: YEAR_2026 }] });
  await uncached.run("list_holidays", { year: 2026 });
  await uncached.run("list_holidays", { year: 2026 });
  assert.equal(uncached.calls.length, 2);
  const misconfigured = createRunner({ environment: { LIBUR_NASIONAL_CACHE_TTL_SECONDS: "6h" }, responses: [] });
  await assert.rejects(misconfigured.run("list_holidays", { year: 2026 }), (error) => error.kind === "invalid_input" && error.message.includes("LIBUR_NASIONAL_CACHE_TTL_SECONDS"));
});

test("a failed fetch is not cached", async () => {
  const { run, calls } = createRunner({ responses: [{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }, { body: YEAR_2026 }] });
  await assert.rejects(run("list_holidays", { year: 2026 }), (error) => error.kind === "api_error");
  const retried = await run("list_holidays", { year: 2026 });
  assert.equal(retried.data.length, 4);
  assert.equal(calls.length, 4);
});

test("list_holidays defaults to the current year in Asia/Jakarta", async () => {
  const { run, calls } = createRunner({ responses: [{ body: YEAR_2027 }], nowIso: "2026-12-31T17:30:00Z" });
  await run("list_holidays", {});
  assert.deepEqual(calls[0].query, { year: "2027" });
});

test("check_date defaults to today in Asia/Jakarta and refuses impossible dates", async () => {
  const { run } = createRunner({ responses: [{ body: YEAR_2026 }], nowIso: "2026-12-24T18:00:00Z" });
  const today = await run("check_date", {});
  assert.equal(today.data.date, "2026-12-25");
  assert.equal(today.data.is_national_holiday, true);
  assert.deepEqual(today.data.holidays, ["Hari Raya Natal"]);
  await assert.rejects(run("check_date", { date: "2026-02-29" }), (error) => error.kind === "invalid_input");
});

test("next_holidays crosses into next year and gives days_away", async () => {
  const { run, calls } = createRunner({ responses: [{ body: YEAR_2026 }, { body: YEAR_2027 }] });
  const { data } = await run("next_holidays", { from_date: "2026-12-01", count: 2 });
  assert.deepEqual(data.holidays.map((holiday) => [holiday.date, holiday.days_away]), [["2026-12-25", 24], ["2027-01-01", 31]]);
  assert.equal(data.coverage_note, undefined);
  assert.deepEqual(calls.map((call) => call.query.year), ["2026", "2027"]);
});

test("next_holidays notes when next year is not published yet instead of failing", async () => {
  const { run } = createRunner({ responses: [{ body: YEAR_2027 }, TOO_LATE] });
  const { data } = await run("next_holidays", { from_date: "2027-06-01" });
  assert.deepEqual(data.holidays, []);
  assert.match(data.coverage_note, /2028.*Maximum year is 2027/);
});

test("a year outside the source's range is invalid_input with its message", async () => {
  const { run } = createRunner({ responses: [TOO_LATE] });
  await assert.rejects(run("list_holidays", { year: 2028 }), (error) => error.kind === "invalid_input" && error.message.includes("Maximum year is 2027"));
});

test("count_working_days spans years and checks its range", async () => {
  const { run } = createRunner({ responses: [{ body: YEAR_2026 }, { body: YEAR_2027 }] });
  const { data } = await run("count_working_days", { start_date: "2026-12-21", end_date: "2027-01-08" });
  assert.equal(data.calendar_days, 19);
  assert.equal(data.weekend_days, 4);
  assert.deepEqual(data.days_off_on_weekdays.map((day) => day.date), ["2026-12-25", "2027-01-01"]);
  assert.equal(data.working_days, 13);
  await assert.rejects(run("count_working_days", { start_date: "2026-02-01", end_date: "2026-01-01" }), (error) => error.kind === "invalid_input");
  await assert.rejects(run("count_working_days", { start_date: "2024-01-01", end_date: "2027-01-01" }), (error) => error.kind === "invalid_input" && error.message.includes("3 calendar years"));
});

test("LIBUR_NASIONAL_API_URL points the plugin at a self-hosted copy; it must be https", async () => {
  const { run, calls } = createRunner({ environment: { LIBUR_NASIONAL_API_URL: "https://libur.example.org/" }, responses: [{ body: YEAR_2026 }] });
  await run("list_holidays", { year: 2026 });
  assert.equal(calls[0].url, "https://libur.example.org/api?year=2026");
  const insecure = createRunner({ environment: { LIBUR_NASIONAL_API_URL: "http://libur.example.org" }, responses: [] });
  await assert.rejects(insecure.run("list_holidays", { year: 2026 }), (error) => error.kind === "invalid_input");
});

test("tool results are truncated, node results are complete", async () => {
  const manyHolidays = Array.from({ length: 4000 }, (_, index) => ({ name: `Libur panjang sekali nomor ${index}`, date: "2026-05-01", is_national_holiday: true }));
  const { run } = createRunner({ responses: [{ body: manyHolidays }] });
  assert.equal((await run("list_holidays", { year: 2026 }, "node")).data.length, 4000);
  assert.equal((await run("list_holidays", { year: 2026 }, "tool")).data.truncated, true);
});
