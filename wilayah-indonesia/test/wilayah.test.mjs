import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { DEFAULT_DATA_REF } from "../lib/dataset-loader.mjs";
import { normalizeRegionCode, parseRegionSql } from "../lib/region-index.mjs";
import { createWilayahDefinition } from "../definition.mjs";

const PINNED_URL = `https://raw.githubusercontent.com/cahyadsn/wilayah/${DEFAULT_DATA_REF}/db/wilayah.sql`;
const FILLER_PROVINCES = Array.from({ length: 30 }, (_, index) => `('${String(61 + index)}','Provinsi ${index}')`);
const FIXTURE_ROWS = [
  "('31','DKI Jakarta')",
  "('31.71','Kota Administrasi Jakarta Pusat')",
  "('32','Jawa Barat')",
  "('32.04','Kabupaten Bandung')",
  "('32.04.05','Cileunyi')",
  "('32.04.05.2001','Cileunyi Kulon')",
  "('32.73','Kota Bandung')",
  "('32.73.02','Coblong')",
  "('32.73.07','Sukajadi')",
  "('32.73.07.1001','Pasteur')",
  "('32.73.07.1002','Cipedes')",
  "('11.01.02.2018','Pasi Kuala Ba''u')",
  "('33.01.01.2001','Bandungan')",
  "('35.04.17','Bandung')",
  ...FILLER_PROVINCES,
];
const FIXTURE_SQL = `-- header\nINSERT INTO wilayah (kode, nama)\nVALUES\n${FIXTURE_ROWS.join(",\n")};\n`;
const FIXTURE_SHA256 = createHash("sha256").update(FIXTURE_SQL).digest("hex");
const sqlResponse = (body = FIXTURE_SQL, status = 200) => ({ status, body, headers: { "content-type": "text/plain; charset=utf-8" } });

function createHarness({ environment = {}, responses = [sqlResponse()], now } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const definition = createWilayahDefinition({ now, pinnedSha256: FIXTURE_SHA256 });
  const runner = createOperationRunner(definition, environment, { fetchImpl: recordingFetch });
  const run = async (operationName, args = {}) => (await runner(operationName, args, { source: "tool" })).data;
  return { run, calls: recordingFetch.calls, definition };
}

test("parseRegionSql reads tuples and un-doubles quotes", () => {
  assert.deepEqual(parseRegionSql("VALUES ('32','Jawa Barat'),\n('11.01.02.2018','Pasi Kuala Ba''u');"), [
    { code: "32", name: "Jawa Barat" },
    { code: "11.01.02.2018", name: "Pasi Kuala Ba'u" },
  ]);
});

test("normalizeRegionCode accepts dotted codes and plain digits, refuses other shapes", () => {
  assert.equal(normalizeRegionCode("32.73", "code"), "32.73");
  assert.equal(normalizeRegionCode(" 3273071001 ", "code"), "32.73.07.1001");
  assert.equal(normalizeRegionCode(32, "code"), "32");
  for (const badCode of ["327", "32.7", "32-73", "32.73.07.10011", "abc"]) {
    assert.throws(() => normalizeRegionCode(badCode, "code"), (error) => error.kind === "invalid_input");
  }
});

test("the dataset is downloaded once from the pinned commit and reused by later calls", async () => {
  const { run, calls } = createHarness();
  const provinces = await run("list_provinces");
  assert.ok(provinces.some((region) => region.code === "32" && region.name === "Jawa Barat"));
  await run("list_regencies", { province_code: "32" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PINNED_URL);
});

test("list_provinces only returns codes that exist as provinces", async () => {
  const { run } = createHarness();
  const provinces = await run("list_provinces");
  assert.equal(provinces.length, 32);
  assert.ok(provinces.every((region) => region.level === "province" && typeof region.name === "string"));
});

test("children are listed by parent code, with or without dots", async () => {
  const { run } = createHarness();
  assert.deepEqual(await run("list_regencies", { province_code: "32" }), [
    { code: "32.04", name: "Kabupaten Bandung", level: "regency" },
    { code: "32.73", name: "Kota Bandung", level: "regency" },
  ]);
  assert.deepEqual(await run("list_districts", { regency_code: "3273" }), [
    { code: "32.73.02", name: "Coblong", level: "district" },
    { code: "32.73.07", name: "Sukajadi", level: "district" },
  ]);
  assert.deepEqual(await run("list_villages", { district_code: "32.73.07" }), [
    { code: "32.73.07.1001", name: "Pasteur", level: "village", type: "kelurahan" },
    { code: "32.73.07.1002", name: "Cipedes", level: "village", type: "kelurahan" },
  ]);
  assert.deepEqual(await run("list_villages", { district_code: "320405" }), [{ code: "32.04.05.2001", name: "Cileunyi Kulon", level: "village", type: "desa" }]);
});

test("a code of the wrong level is invalid_input, an unknown code is not_found", async () => {
  const { run } = createHarness();
  await assert.rejects(run("list_districts", { regency_code: "32" }), (error) => error.kind === "invalid_input" && error.message.includes("regency code"));
  await assert.rejects(run("list_regencies", { province_code: "99" }), (error) => error.kind === "not_found" && error.message.includes("99"));
  await assert.rejects(run("get_region", { code: "32/73" }), (error) => error.kind === "invalid_input");
});

test("get_region returns the parent chain and the full address", async () => {
  const { run } = createHarness();
  assert.deepEqual(await run("get_region", { code: "3273071001" }), {
    code: "32.73.07.1001",
    name: "Pasteur",
    level: "village",
    type: "kelurahan",
    parents: [
      { code: "32", name: "Jawa Barat", level: "province" },
      { code: "32.73", name: "Kota Bandung", level: "regency" },
      { code: "32.73.07", name: "Sukajadi", level: "district" },
    ],
    address: "Pasteur, Sukajadi, Kota Bandung, Jawa Barat",
    child_count: 0,
  });
});

test("search_regions ranks exact names first and ignores case, accents and the Kabupaten/Kota prefix", async () => {
  const { run } = createHarness();
  const result = await run("search_regions", { query: "BANDUNG" });
  // Exact names (also without the Kabupaten/Kota prefix) first, higher levels before lower ones, then prefixes.
  assert.deepEqual(result.regions.map((region) => region.code), ["32.04", "32.73", "35.04.17", "33.01.01.2001"]);
  assert.equal(result.total_matches, 4);
  assert.equal(result.regions[1].address, "Kota Bandung, Jawa Barat");
  const accented = await run("search_regions", { query: "Pásteur" });
  assert.deepEqual(accented.regions.map((region) => region.code), ["32.73.07.1001"]);
  const quoted = await run("search_regions", { query: "kuala ba'u" });
  assert.deepEqual(quoted.regions.map((region) => region.code), ["11.01.02.2018"]);
});

test("search_regions filters by level and within_code and honours limit", async () => {
  const { run } = createHarness();
  assert.deepEqual((await run("search_regions", { query: "bandung", level: "village" })).regions.map((region) => region.code), ["33.01.01.2001"]);
  assert.deepEqual((await run("search_regions", { query: "bandung", within_code: "32" })).regions.map((region) => region.code), ["32.04", "32.73"]);
  const limited = await run("search_regions", { query: "bandung", limit: 1 });
  assert.equal(limited.regions.length, 1);
  assert.equal(limited.total_matches, 4);
  await assert.rejects(run("search_regions", { query: "--" }), (error) => error.kind === "invalid_input");
});

test("a download that is not the dataset is an api_error and is not cached", async () => {
  // A branch ref has no known hash, so the province-count check is what refuses the HTML page.
  const { run, calls } = createHarness({ environment: { WILAYAH_INDONESIA_DATA_REF: "master" }, responses: [sqlResponse("<html>rate limited</html>"), sqlResponse()] });
  await assert.rejects(run("list_provinces"), (error) => error.kind === "api_error" && error.message.includes("not a valid wilayah.sql"));
  assert.ok((await run("list_provinces")).length > 0);
  assert.equal(calls.length, 2);
});

test("a missing ref (404) is not_found", async () => {
  const { run } = createHarness({ environment: { WILAYAH_INDONESIA_DATA_REF: "no-such-branch" }, responses: [sqlResponse("404: Not Found", 404)] });
  await assert.rejects(run("list_provinces"), (error) => error.kind === "not_found");
});

test("WILAYAH_INDONESIA_DATA_REF selects the ref and is validated before any request", async () => {
  const selected = createHarness({ environment: { WILAYAH_INDONESIA_DATA_REF: "master" } });
  await selected.run("list_provinces");
  assert.equal(selected.calls[0].url, "https://raw.githubusercontent.com/cahyadsn/wilayah/master/db/wilayah.sql");
  for (const badRef of ["../../evil", "a/b", "x?y", ".hidden"]) {
    const refused = createHarness({ environment: { WILAYAH_INDONESIA_DATA_REF: badRef } });
    await assert.rejects(refused.run("list_provinces"), (error) => error.kind === "invalid_input");
    assert.equal(refused.calls.length, 0);
  }
  const relativeCache = createHarness({ environment: { WILAYAH_INDONESIA_CACHE_DIR: "cache" } });
  await assert.rejects(relativeCache.run("list_provinces"), (error) => error.kind === "invalid_input");
});

test("the disk cache is reused by a new process; branch copies expire after the TTL", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "wilayah-cache-"));
  try {
    const environment = { WILAYAH_INDONESIA_CACHE_DIR: cacheDirectory, WILAYAH_INDONESIA_DATA_REF: "master", WILAYAH_INDONESIA_CACHE_TTL_HOURS: "1" };
    const first = createHarness({ environment });
    await first.run("list_provinces");
    assert.deepEqual(await readdir(cacheDirectory), ["wilayah-master.sql"]);
    const second = createHarness({ environment, responses: [] });
    assert.ok((await second.run("list_provinces")).length > 0);
    assert.equal(second.calls.length, 0);
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    await utimes(join(cacheDirectory, "wilayah-master.sql"), twoHoursAgo, twoHoursAgo);
    const third = createHarness({ environment });
    await third.run("list_provinces");
    assert.equal(third.calls.length, 1);
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

test("the in-memory copy of a branch is refreshed after the TTL; a pinned commit never expires", async () => {
  let clock = 0;
  const branch = createHarness({ environment: { WILAYAH_INDONESIA_DATA_REF: "master", WILAYAH_INDONESIA_CACHE_TTL_HOURS: "1" }, responses: [sqlResponse(), sqlResponse()], now: () => clock });
  await branch.run("list_provinces");
  clock = 2 * 3600 * 1000;
  await branch.run("list_provinces");
  assert.equal(branch.calls.length, 2);
  clock = 0;
  const pinned = createHarness({ now: () => clock });
  await pinned.run("list_provinces");
  clock = 1000 * 24 * 3600 * 1000;
  await pinned.run("list_provinces");
  assert.equal(pinned.calls.length, 1);
});

test("the manifest asks for the network only: no secrets, no access_token, every operation a tool", () => {
  const manifest = buildManifest(createWilayahDefinition());
  assert.deepEqual(manifest.permissions, { network: true, secrets: false, env: ["WILAYAH_INDONESIA_DATA_REF", "WILAYAH_INDONESIA_DATA_SHA256", "WILAYAH_INDONESIA_CACHE_DIR", "WILAYAH_INDONESIA_CACHE_TTL_HOURS"] });
  assert.ok(manifest.nodes.every((node) => !("access_token" in node.config_schema.properties)));
  assert.equal(manifest.tools.length, manifest.nodes.length);
});
