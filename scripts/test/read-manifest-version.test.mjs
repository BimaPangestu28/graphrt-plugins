import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import { readManifestVersion } from "../read-manifest-version.mjs";

const scriptPath = join(REPO_ROOT, "scripts", "read-manifest-version.mjs");

test("prints the manifest version of a plugin", () => {
  const expectedVersion = JSON.parse(readFileSync(join(REPO_ROOT, "open-meteo", "graphrt-plugin.json"), "utf8")).version;
  assert.equal(readManifestVersion("open-meteo"), expectedVersion);
  const result = spawnSync(process.execPath, [scriptPath, "open-meteo"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${expectedVersion}\n`);
});

test("refuses names that are not plugin names, so a tag can never inject code or escape the repo", () => {
  for (const pluginName of ["'); process.exit(0); ('", "../package", "open-meteo/../x", "Open-Meteo", "", "a--b", "-x"]) {
    assert.throws(() => readManifestVersion(pluginName), /is not a plugin name/, pluginName);
    const result = spawnSync(process.execPath, [scriptPath, pluginName], { encoding: "utf8" });
    assert.equal(result.status, 1, pluginName);
    assert.equal(result.stdout, "");
  }
  assert.throws(() => readManifestVersion("no-such-plugin"), /ENOENT/);
});
