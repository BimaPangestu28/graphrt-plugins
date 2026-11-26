import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE, MANIFEST_FEATURES, appRequirementFields, compareAppVersions, describeAppRequirement, findDeclaredRequirementProblems,
  findUnaccountedManifestFeatures, parseAppVersion, readDeclaredRequirements,
} from "../lib/app-requirements.mjs";
import { buildCatalogV2Entry, buildPluginDetail, renderPluginDetail } from "../lib/catalog-v2.mjs";
import { assembleCatalogEntry, buildCatalogEntry, listPluginNames } from "../lib/plugin-package.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const processManifest = {
  name: "open-meteo", version: "1.0.0", description: "Weather", runtime: "process", command: "node", args: ["plugin.mjs"],
  permissions: { network: true, secrets: false, env: [] }, limits: { timeout_ms: 1000, max_concurrency: 2 },
  nodes: [{ kind: "open-meteo.forecast", title: "Forecast", description: "d", category: "integration", config_schema: { type: "object" }, outputs: [{ name: "data", type: "any", description: "d" }] }],
  tools: [{ name: "forecast", description: "d", parameters: { type: "object" } }],
};

function repoManifest(pluginName) {
  return JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
}

test("parses and orders app versions by number, not by text", () => {
  assert.deepEqual(parseAppVersion("0.2.0"), [0, 2, 0]);
  for (const invalid of ["0.2", "v0.2.0", "0.2.0-beta", "01.2.0", "", null, 2]) assert.equal(parseAppVersion(invalid), null, String(invalid));
  assert.ok(compareAppVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareAppVersions("0.1.8", "0.2.0") < 0);
  assert.ok(compareAppVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareAppVersions("0.2.0", "0.2.0"), 0);
  assert.throws(() => compareAppVersions("0.2", "0.2.0"), /`0.2` is not an app version/);
});

test("a plugin that uses nothing new needs no minimum version", () => {
  assert.deepEqual(describeAppRequirement(processManifest, {}), { minAppVersion: null, reasons: [] });
  assert.deepEqual(appRequirementFields(processManifest, {}), {});
});

test("the minimum version comes from what the manifest uses", () => {
  assert.equal(describeAppRequirement({ ...processManifest, triggers: [{ id: "x", title: "X", watch: "forecast" }] }, {}).minAppVersion, "0.2.0");
  // The key alone is enough: the strict reader of an older app refuses it even when it is empty.
  assert.equal(describeAppRequirement({ ...processManifest, triggers: [] }, {}).minAppVersion, "0.2.0");
  assert.equal(describeAppRequirement({ ...processManifest, templates: [] }, {}).minAppVersion, "0.2.0");
  const preset = { name: "upwork", version: "1.0.0", runtime: "mcp", mcp: { url: "https://mcp.example.test/mcp" }, permissions: { network: true } };
  assert.deepEqual(appRequirementFields(preset, {}), { min_app_version: "0.2.0" });
});

test("a declared floor raises the version and never lowers what the manifest needs", () => {
  const withTriggers = { ...processManifest, triggers: [] };
  const raised = describeAppRequirement(withTriggers, { "open-meteo": { min_app_version: "0.10.0", reason: "needs the new map view" } });
  assert.equal(raised.minAppVersion, "0.10.0");
  assert.deepEqual(raised.reasons.map((entry) => entry.minAppVersion), ["0.2.0", "0.10.0"]);
  assert.equal(describeAppRequirement(withTriggers, { "open-meteo": { min_app_version: "0.1.0", reason: "old" } }).minAppVersion, "0.2.0");
  assert.equal(describeAppRequirement(processManifest, { "another-plugin": { min_app_version: "9.0.0", reason: "x" } }).minAppVersion, null);
  // An inherited object key is not a declaration.
  assert.equal(describeAppRequirement({ ...processManifest, name: "constructor" }, {}).minAppVersion, null);
});

test("reports invalid declared floors", () => {
  const problems = findDeclaredRequirementProblems(
    {
      "ui-render": { min_app_version: "0.2.0", reason: "draws cards" },
      ghost: { min_app_version: "0.2.0", reason: "x" },
      bmkg: { min_app_version: "0.2", reason: " ", owner: "me" },
      fonnte: "0.2.0",
    },
    ["bmkg", "fonnte", "ui-render"],
  );
  assert.deepEqual(problems, [
    "ghost: no such plugin directory",
    "bmkg: unknown field `owner`",
    'bmkg: `min_app_version` must be major.minor.patch, e.g. "0.2.0"',
    "bmkg: `reason` must say what the app has to be able to do",
    "fonnte: the entry must be an object",
  ]);
});

test("a manifest feature without a known first version is reported", () => {
  assert.deepEqual(findUnaccountedManifestFeatures(processManifest), []);
  const future = {
    ...processManifest,
    runtime: "container",
    widgets: [],
    permissions: { network: true, camera: true },
    limits: { timeout_ms: 1, max_memory_mb: 64 },
    nodes: [{ ...processManifest.nodes[0], badge: "new", outputs: [{ name: "image", type: "image", mime: "image/png" }] }],
  };
  const found = findUnaccountedManifestFeatures(future).map((problem) => problem.replace(/ is not read by Desktop .*/, ""));
  assert.deepEqual(found, [
    "open-meteo: manifest key `widgets`",
    "open-meteo: runtime `container`",
    "open-meteo: permissions key `camera`",
    "open-meteo: limits key `max_memory_mb`",
    "open-meteo: node open-meteo.forecast: key `badge`",
    "open-meteo: node open-meteo.forecast: output key `mime`",
    "open-meteo: node open-meteo.forecast: output type `image`",
  ]);
  assert.match(findUnaccountedManifestFeatures(future)[0], new RegExp(`is not read by Desktop ${BASELINE.appVersion.replaceAll(".", "\\.")} and has no entry in MANIFEST_FEATURES`));
});

test("every manifest feature states a valid version and what it covers", () => {
  for (const feature of MANIFEST_FEATURES) {
    assert.ok(parseAppVersion(feature.minAppVersion), feature.id);
    assert.ok(compareAppVersions(feature.minAppVersion, BASELINE.appVersion) > 0, `${feature.id} must be newer than the baseline`);
    assert.ok(feature.reason.trim(), feature.id);
    for (const key of feature.manifestKeys ?? []) assert.ok(!BASELINE.manifestKeys.has(key), `${key} is already in the baseline`);
  }
  assert.equal(new Set(MANIFEST_FEATURES.map((feature) => feature.id)).size, MANIFEST_FEATURES.length);
});

test("the repo's plugins: every feature in use is accounted for and the declared floors are valid", () => {
  const pluginNames = listPluginNames();
  assert.deepEqual(findDeclaredRequirementProblems(readDeclaredRequirements(), pluginNames), []);
  assert.deepEqual(pluginNames.flatMap((pluginName) => findUnaccountedManifestFeatures(repoManifest(pluginName))), []);
});

test("catalog entries carry min_app_version in v1 and v2, and only when a plugin needs one", () => {
  const tarball = { sha256: "f".repeat(64), sizeBytes: 123 };
  const meetingNotes = repoManifest("meeting-notes");
  const meetingEntry = buildCatalogEntry(meetingNotes, tarball);
  assert.equal(meetingEntry.min_app_version, "0.2.0");
  assert.equal(buildCatalogV2Entry(meetingEntry, renderPluginDetail(buildPluginDetail(meetingNotes))).min_app_version, "0.2.0");
  assert.equal(buildCatalogEntry(repoManifest("ui-render"), tarball).min_app_version, "0.2.0");
  assert.equal(buildCatalogEntry(repoManifest("upwork"), tarball).min_app_version, "0.2.0");

  const plain = repoManifest("open-meteo");
  const plainEntry = buildCatalogEntry(plain, tarball);
  assert.ok(!Object.hasOwn(plainEntry, "min_app_version"));
  assert.ok(!Object.hasOwn(buildCatalogV2Entry(plainEntry, renderPluginDetail(buildPluginDetail(plain))), "min_app_version"));
});

test("a community entry gets its version from its manifest, never from this repo's declared floors", () => {
  const listing = {
    displayName: "UI Render", iconAssetName: "icon-x-0123456789ab.svg", tarballUrl: "https://example.invalid/x.tar.gz", needsBrowser: false,
    statusEntry: { status: "beta", reason: "r", tos_risk: "none" }, source: "community", publisher: "Acme", repositoryUrl: "https://github.com/acme/x",
    readmeUrl: "https://github.com/acme/x/blob/v1.0.0/README.md",
  };
  const tarball = { sha256: "0".repeat(64), sizeBytes: 1 };
  assert.ok(!Object.hasOwn(assembleCatalogEntry({ ...processManifest, name: "ui-render" }, tarball, listing), "min_app_version"));
  assert.equal(assembleCatalogEntry({ ...processManifest, triggers: [] }, tarball, listing).min_app_version, "0.2.0");
});
