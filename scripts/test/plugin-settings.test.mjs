import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import { buildCatalogV2Entry, buildPluginDetail, renderPluginDetail } from "../lib/catalog-v2.mjs";
import { buildCatalogEntry, describeTarballBytes, listPluginNames } from "../lib/plugin-package.mjs";
import { MAX_SETTINGS_FILE_BYTES, SETTINGS_FILE_NAME, findSettingProblems, parsePluginSettings } from "../lib/plugin-settings.mjs";
import { createTarGz } from "../lib/tar-archive.mjs";

const permittedNames = ["ACME_OUTPUT_DIR", "ACME_API_KEY", "ACME_MAX_PAGES", "ACME_FONTS"];

test("a settings item needs a declared name, a known kind and texts people can read", () => {
  const valid = [
    { name: "ACME_OUTPUT_DIR" },
    { name: "ACME_OUTPUT_DIR", label: "Folder for finished documents", help: "Where your documents are saved.", kind: "folder", required: true },
    { name: "ACME_API_KEY", kind: "secret", required: true },
    { name: "ACME_MAX_PAGES", kind: "number", default: 200 },
    { name: "ACME_FONTS", kind: "file", multiple: true, required: false },
    { name: "ACME_FONTS", kind: "text", default: "none" },
  ];
  for (const item of valid) assert.deepEqual(findSettingProblems(item, permittedNames), [], JSON.stringify(item));
  const invalid = [
    [null, /must be an object/],
    [{ label: "No name" }, /needs a `name`/],
    [{ name: "ACME_OTHER" }, /not in the manifest's permissions\.env/],
    [{ name: "ACME_OUTPUT_DIR", kind: "directory" }, /`kind` must be one of text, secret, number, folder, file/],
    [{ name: "ACME_OUTPUT_DIR", label: "x".repeat(81) }, /`label` is longer than 80/],
    [{ name: "ACME_OUTPUT_DIR", help: "y".repeat(301) }, /`help` is longer than 300/],
    [{ name: "ACME_OUTPUT_DIR", label: "" }, /`label` must be a text/],
    [{ name: "ACME_OUTPUT_DIR", help: "Set ACME_OUTPUT_DIR to a folder." }, /must not name a variable \(ACME_OUTPUT_DIR\)/],
    [{ name: "ACME_OUTPUT_DIR", required: "yes" }, /`required` must be true or false/],
    [{ name: "ACME_FONTS", multiple: 1 }, /`multiple` must be true or false/],
    [{ name: "ACME_MAX_PAGES", kind: "number", default: "200" }, /`default` of a number setting must be a number/],
    [{ name: "ACME_MAX_PAGES", default: { pages: 200 } }, /`default` must be a text, a number or true\/false/],
    [{ name: "ACME_MAX_PAGES", default: 200, required: true }, /never required/],
    [{ name: "ACME_API_KEY", kind: "secret", default: "abc" }, /a secret has no `default`/],
    [{ name: "ACME_OUTPUT_DIR", placeholder: "/home/me" }, /unknown field `placeholder`/],
  ];
  for (const [item, pattern] of invalid) assert.match(findSettingProblems(item, permittedNames).join("; "), pattern, JSON.stringify(item));
});

test("a settings file keeps its valid items and names every problem", () => {
  const text = JSON.stringify({ settings: [{ name: "ACME_OUTPUT_DIR", kind: "folder", required: true }, { name: "ACME_OTHER" }, "x", { name: "ACME_OUTPUT_DIR" }, { name: "ACME_MAX_PAGES", kind: "number", default: 200 }] });
  const parsed = parsePluginSettings(text, permittedNames);
  assert.deepEqual(parsed.settings.map((item) => item.name), ["ACME_OUTPUT_DIR", "ACME_MAX_PAGES"]);
  assert.deepEqual(parsed.problems, ["ACME_OTHER: `name` is not in the manifest's permissions.env", "settings[2]: must be an object", "ACME_OUTPUT_DIR: is listed twice"]);
  for (const [unusable, pattern] of [["{", /not valid JSON/], ["[]", /`settings` list/], [JSON.stringify({ settings: {} }), /`settings` list/], [`{"settings":[],"pad":"${"x".repeat(MAX_SETTINGS_FILE_BYTES)}"}`, /larger than 65536 bytes/]]) {
    const result = parsePluginSettings(unusable, permittedNames);
    assert.deepEqual(result.settings, []);
    assert.match(result.problems.join("; "), pattern);
  }
  assert.match(parsePluginSettings(JSON.stringify({ settings: [], version: 2 }), permittedNames).problems.join("; "), /unknown field `version`/);
});

test("every plugin's graphrt-settings.json is valid against its manifest", () => {
  const pluginsWithSettings = listPluginNames().filter((pluginName) => existsSync(join(REPO_ROOT, pluginName, SETTINGS_FILE_NAME)));
  assert.ok(pluginsWithSettings.includes("document-templates"));
  for (const pluginName of pluginsWithSettings) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
    const parsed = parsePluginSettings(readFileSync(join(REPO_ROOT, pluginName, SETTINGS_FILE_NAME), "utf8"), manifest.permissions?.env ?? []);
    assert.deepEqual(parsed.problems, [], `${pluginName}/${SETTINGS_FILE_NAME}`);
    assert.ok(parsed.settings.length > 0, `${pluginName}/${SETTINGS_FILE_NAME} lists no settings`);
  }
});

test("the catalog entry repeats the settings shipped in the tarball, in both indexes and not in the detail file", () => {
  const pluginFile = (fileName) => readFileSync(join(REPO_ROOT, "document-templates", fileName));
  const tarballBytes = createTarGz(
    [{ path: "document-templates", type: "directory" }, ...["graphrt-plugin.json", SETTINGS_FILE_NAME].map((fileName) => ({ path: `document-templates/${fileName}`, type: "file", content: pluginFile(fileName) }))],
    { mtimeSeconds: 0 },
  );
  const published = describeTarballBytes("document-templates-0.2.0.tar.gz", tarballBytes);
  assert.equal(published.settingsText, pluginFile(SETTINGS_FILE_NAME).toString("utf8"));
  const entry = buildCatalogEntry(published.manifest, published);
  assert.deepEqual(entry.settings, JSON.parse(published.settingsText).settings);
  assert.deepEqual(entry.settings.filter((item) => item.required).map((item) => item.name), ["DOCUMENT_TEMPLATES_OUTPUT_DIR"]);
  assert.deepEqual(entry.settings.map((item) => item.name).sort(), [...entry.permissions.env].sort());
  const detail = buildPluginDetail(published.manifest);
  assert.ok(!Object.hasOwn(detail, "settings"));
  assert.deepEqual(buildCatalogV2Entry(entry, renderPluginDetail(detail)).settings, entry.settings);
});

test("a plugin without the file has no `settings`, and broken items of a published file are left out", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "qr-code", "graphrt-plugin.json"), "utf8"));
  const tarball = { sha256: "a".repeat(64), sizeBytes: 10 };
  assert.ok(!Object.hasOwn(buildCatalogEntry(manifest, tarball), "settings"));
  assert.ok(!Object.hasOwn(buildCatalogEntry(manifest, { ...tarball, settingsText: "not json" }), "settings"));
  const documentManifest = JSON.parse(readFileSync(join(REPO_ROOT, "document-templates", "graphrt-plugin.json"), "utf8"));
  const settingsText = JSON.stringify({ settings: [{ name: "DOCUMENT_TEMPLATES_MAX_PAGES", kind: "pages" }, { name: "DOCUMENT_TEMPLATES_OUTPUT_DIR", kind: "folder", required: true }] });
  assert.deepEqual(buildCatalogEntry(documentManifest, { ...tarball, settingsText }).settings, [{ name: "DOCUMENT_TEMPLATES_OUTPUT_DIR", kind: "folder", required: true }]);
  const tarballBytes = createTarGz([{ path: "x", type: "directory" }, { path: "x/graphrt-plugin.json", type: "file", content: Buffer.from("{}") }, { path: "x/lib/graphrt-settings.json", type: "file", content: Buffer.from("{}") }], { mtimeSeconds: 0 });
  assert.equal(describeTarballBytes("x-1.0.0.tar.gz", tarballBytes).settingsText, null);
});
