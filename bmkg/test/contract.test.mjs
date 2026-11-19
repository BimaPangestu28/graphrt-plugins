import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { shapeOperationResults } from "../lib/bmkg-results.mjs";
import { pluginDefinition, restDefinition, RESULT_SHAPERS } from "../definition.mjs";

// The generated contract expects "../../escape" in a path param to be sent as one encoded segment, but the plugin
// refuses any alert_code that is not letters and digits before the request (tested in response-limits.test.mjs).
// So the contract runs on the same shaping without that one argument check.
const { checkArgs: _alertCodeCheck, ...warningShaperWithoutCheck } = RESULT_SHAPERS.get_weather_warning;
const contractDefinition = shapeOperationResults(restDefinition, { ...RESULT_SHAPERS, get_weather_warning: warningShaperWithoutCheck });

const DATA = "https://data.bmkg.go.id/DataMKG/TEWS";
const LATEST = { Tanggal: "19 Nov 2026", Jam: "08:34:48 WIB", DateTime: "2026-11-19T01:34:48+00:00", Magnitude: "5.4", Shakemap: "20261119083720.mmi.jpg" };
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><lastBuildDate>Thu, 19 Nov 2026 02:00:50 +0000</lastBuildDate>
<item><title>Hujan Lebat di NTB</title><link>https://www.bmkg.go.id/alerts/nowcast/en/CNB20261119001_alert.xml</link><description>Heavy rain</description><pubDate>Thu, 19 Nov 2026 09:35:00 +0800</pubDate></item></channel></rss>`;
const CAP = `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>2.49.0.1</identifier><info><event>Hujan Lebat</event><severity>Moderate</severity>
<area><areaDesc>NTB</areaDesc><polygon>-8.6,116.0 -8.7,116.1 -8.6,116.0</polygon></area></info></alert>`;
const XML_ACCEPT = "application/rss+xml, application/xml;q=0.9, */*;q=0.1";

describeRestPluginContract(contractDefinition, {
  operations: {
    get_latest_earthquake: {
      args: {},
      request: { method: "GET", url: `${DATA}/autogempa.json`, query: "absent" },
      response: { body: { Infogempa: { gempa: LATEST } } },
      expect: { data: { ...LATEST, shakemap_url: `${DATA}/20261119083720.mmi.jpg` } },
    },
    list_recent_earthquakes: {
      args: {},
      request: { method: "GET", url: `${DATA}/gempaterkini.json`, query: "absent" },
      response: { body: { Infogempa: { gempa: [{ Magnitude: "5.8" }] } } },
      expect: { data: [{ Magnitude: "5.8" }] },
    },
    list_felt_earthquakes: {
      args: {},
      request: { method: "GET", url: `${DATA}/gempadirasakan.json`, query: "absent" },
      response: { body: { Infogempa: { gempa: [{ Magnitude: "4.0", Dirasakan: "II Kab. Manggarai" }] } } },
      expect: { data: [{ Magnitude: "4.0", Dirasakan: "II Kab. Manggarai" }] },
    },
    get_weather_forecast: {
      args: { adm4: "31.71.03.1001" },
      request: { method: "GET", url: "https://api.bmkg.go.id/publik/prakiraan-cuaca", query: { adm4: "31.71.03.1001" } },
      response: { body: { lokasi: { desa: "Kemayoran" }, data: [{ lokasi: { desa: "Kemayoran" }, cuaca: [[{ t: 28 }, { t: 29 }], [{ t: 27 }]] }] } },
      expect: { data: { location: { desa: "Kemayoran" }, forecasts: [{ t: 28 }, { t: 29 }, { t: 27 }] } },
    },
    list_weather_warnings: {
      args: { language: "en" },
      request: { method: "GET", url: "https://www.bmkg.go.id/alerts/nowcast/en", query: "absent", headers: { Accept: XML_ACCEPT } },
      response: { body: RSS, headers: { "content-type": "application/xml" } },
      expect: {
        data: {
          updated_at: "Thu, 19 Nov 2026 02:00:50 +0000",
          warnings: [
            {
              alert_code: "CNB20261119001",
              title: "Hujan Lebat di NTB",
              description: "Heavy rain",
              author: null,
              published_at: "Thu, 19 Nov 2026 09:35:00 +0800",
              link: "https://www.bmkg.go.id/alerts/nowcast/en/CNB20261119001_alert.xml",
            },
          ],
        },
      },
    },
    get_weather_warning: {
      args: { language: "id", alert_code: "CNB20261119001", include_polygons: true },
      request: { method: "GET", url: "https://www.bmkg.go.id/alerts/nowcast/id/CNB20261119001_alert.xml", query: "absent", headers: { Accept: XML_ACCEPT } },
      response: { body: CAP, headers: { "content-type": "application/xml" } },
    },
  },
});

async function runOperation(operationName, args, responses, source = "tool") {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source }), calls: recordingFetch.calls };
}

test("bmkg needs no credential: no secrets, no env, no node access_token, every operation is a tool", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: true, secrets: false, env: [] });
  assert.equal(manifest.tools.length, manifest.nodes.length);
  assert.equal("access_token" in manifest.nodes[0].config_schema.properties, false);
});

test("get_weather_forecast refuses malformed adm4 codes before any request", async () => {
  for (const adm4 of ["31.71.03", "31.71.03.1001&adm4=x", "3171031001", "../31.71.03.1001"]) {
    const recordingFetch = createRecordingFetch([]);
    const run = createOperationRunner(pluginDefinition, {}, { fetchImpl: recordingFetch });
    await assert.rejects(run("get_weather_forecast", { adm4 }, { source: "tool" }), (error) => error.kind === "invalid_input" && error.message.includes("adm4"));
    assert.equal(recordingFetch.calls.length, 0);
  }
});

test("an unknown village is a not_found error with BMKG's message", async () => {
  await assert.rejects(
    runOperation("get_weather_forecast", { adm4: "99.99.99.9999" }, [{ status: 404, body: { error: "Data cuaca tidak ditemukan" } }]),
    (error) => error.kind === "not_found" && error.message.includes("Data cuaca tidak ditemukan"),
  );
});

test("get_weather_warning leaves polygons out by default and never sends include_polygons", async () => {
  const { result, calls } = await runOperation("get_weather_warning", { language: "id", alert_code: "CNB20261119001" }, [{ body: CAP }]);
  assert.equal(result.data.event, "Hujan Lebat");
  assert.equal(result.data.area_description, "NTB");
  assert.equal(result.data.polygons, undefined);
  assert.deepEqual(calls[0].query, {});
  const withPolygons = await runOperation("get_weather_warning", { language: "id", alert_code: "CNB20261119001", include_polygons: "true" }, [{ body: CAP }]);
  assert.deepEqual(withPolygons.result.data.polygons, [[[-8.6, 116], [-8.7, 116.1], [-8.6, 116]]]);
});

test("get_weather_warning refuses a hostile alert_code before any request", async () => {
  await assert.rejects(runOperation("get_weather_warning", { language: "id", alert_code: "CNB_1?x=1" }, []), (error) => error.kind === "invalid_input" && error.message.includes("alert_code"));
});

test("an HTML page instead of the RSS feed is an api_error, not an empty list", async () => {
  await assert.rejects(runOperation("list_weather_warnings", { language: "id" }, [{ body: "<html>Just a moment...</html>" }]), (error) => error.kind === "api_error");
});

test("a shakemap name that is not a plain image file name gets no URL", async () => {
  const { result } = await runOperation("get_latest_earthquake", {}, [{ body: { Infogempa: { gempa: { Shakemap: "../x.jpg" } } } }]);
  assert.equal(result.data.shakemap_url, undefined);
});

test("tool results are truncated after shaping; node results are complete", async () => {
  const many = Array.from({ length: 3000 }, (_, index) => ({ t: index, weather_desc: "Berawan tebal sepanjang hari" }));
  const body = { lokasi: {}, data: [{ cuaca: [many] }] };
  const toolRun = await runOperation("get_weather_forecast", { adm4: "31.71.03.1001" }, [{ body }], "tool");
  assert.equal(toolRun.result.data.truncated, true);
  const nodeRun = await runOperation("get_weather_forecast", { adm4: "31.71.03.1001" }, [{ body }], "node");
  assert.equal(nodeRun.result.data.forecasts.length, 3000);
});
