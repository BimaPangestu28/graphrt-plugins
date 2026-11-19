import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listPluginNames } from "../lib/plugin-package.mjs";
import {
  PLUGIN_STATUS_LEVELS, TOS_RISK_LEVELS, applyReadmeStatusLine, applyStatusColumns, findPluginStatusProblems, formatReadmeStatusLine,
  readPluginStatuses, statusForPlugin,
} from "../lib/plugin-status.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const sampleStatuses = {
  "open-meteo": { status: "stable", reason: "Real forecast read live.", tos_risk: "none" },
  "whatsapp-web": { status: "experimental", reason: "Unofficial WhatsApp Web automation.", tos_risk: "high", tos_notes: "WhatsApp ToS forbids automated means." },
};

test("every plugin directory has exactly one valid status entry", () => {
  const pluginStatuses = readPluginStatuses();
  assert.deepEqual(findPluginStatusProblems(pluginStatuses, listPluginNames()), []);
  assert.deepEqual(Object.keys(pluginStatuses).sort(), listPluginNames());
});

test("plugin-status.json has no duplicate keys", () => {
  const statusText = readFileSync(join(REPO_ROOT, "plugin-status.json"), "utf8");
  const keyMatches = [...statusText.matchAll(/^ {2}"([^"]+)": \{/gm)].map((match) => match[1]);
  assert.equal(new Set(keyMatches).size, keyMatches.length);
  assert.equal(keyMatches.length, listPluginNames().length);
});

test("reports missing, unknown and invalid entries", () => {
  const problems = findPluginStatusProblems(
    {
      "open-meteo": { status: "done", reason: "", tos_risk: "none" },
      "whatsapp-web": { status: "experimental", reason: "Unofficial.", tos_risk: "high" },
      "ghost-plugin": { status: "beta", reason: "x", tos_risk: "low" },
      bmkg: { status: "beta", reason: "x", tos_risk: "extreme", owner: "me" },
    },
    ["bmkg", "open-meteo", "whatsapp-web", "wikipedia"],
  );
  assert.deepEqual(problems, [
    "wikipedia: missing from plugin-status.json",
    "open-meteo: status `done` must be one of stable, beta, experimental",
    "open-meteo: reason must be a non-empty string",
    "whatsapp-web: tos_risk high needs tos_notes",
    "ghost-plugin: no such plugin directory",
    "bmkg: tos_risk `extreme` must be one of none, low, medium, high",
    "bmkg: unknown field `owner`",
  ]);
});

test("exposes the allowed levels in order", () => {
  assert.deepEqual(PLUGIN_STATUS_LEVELS, ["stable", "beta", "experimental"]);
  assert.deepEqual(TOS_RISK_LEVELS, ["none", "low", "medium", "high"]);
});

test("looks up one plugin's status and refuses an unknown plugin", () => {
  assert.equal(statusForPlugin(sampleStatuses, "open-meteo").status, "stable");
  assert.throws(() => statusForPlugin(sampleStatuses, "nope"), /nope: no entry in plugin-status.json/);
});

test("formats the README status line from the entry", () => {
  assert.equal(
    formatReadmeStatusLine(sampleStatuses["whatsapp-web"]),
    "**Status:** experimental · **ToS risk:** high. Unofficial WhatsApp Web automation. See [plugin status](../README.md#plugin-status).",
  );
});

test("inserts the status line under the title, then replaces it in place", () => {
  const readmeText = "# open-meteo\n\n## Overview\nWeather.\n";
  const withStatus = applyReadmeStatusLine(readmeText, sampleStatuses["open-meteo"]);
  assert.equal(withStatus, `# open-meteo\n\n${formatReadmeStatusLine(sampleStatuses["open-meteo"])}\n\n## Overview\nWeather.\n`);
  const changed = applyReadmeStatusLine(withStatus, { ...sampleStatuses["open-meteo"], status: "beta" });
  assert.match(changed, /^# open-meteo\n\n\*\*Status:\*\* beta · /);
  assert.equal(changed.match(/\*\*Status:\*\*/g).length, 1);
  assert.equal(applyReadmeStatusLine(withStatus, sampleStatuses["open-meteo"]), withStatus);
});

test("refuses a README without a title line", () => {
  assert.throws(() => applyReadmeStatusLine("No title\n", sampleStatuses["open-meteo"]), /must start with a `# ` title/);
});

test("adds Status and ToS risk columns to the plugin table, idempotently", () => {
  const rootReadme = [
    "## Plugins",
    "| Plugin | What it does | Operations |",
    "|--------|--------------|-----------:|",
    "| [open-meteo](open-meteo/) | Weather | 2 |",
    "| [whatsapp-web](whatsapp-web/) | Chats | 7 |",
    "",
    "## Usage",
  ].join("\n");
  const withColumns = applyStatusColumns(rootReadme, sampleStatuses);
  assert.deepEqual(withColumns.split("\n").slice(1, 5), [
    "| Plugin | Status | ToS risk | What it does | Operations |",
    "|--------|--------|----------|--------------|-----------:|",
    "| [open-meteo](open-meteo/) | stable | none | Weather | 2 |",
    "| [whatsapp-web](whatsapp-web/) | experimental | **high** | Chats | 7 |",
  ]);
  assert.equal(applyStatusColumns(withColumns, sampleStatuses), withColumns);
  const updated = applyStatusColumns(withColumns, { ...sampleStatuses, "open-meteo": { ...sampleStatuses["open-meteo"], status: "beta" } });
  assert.match(updated, /\| \[open-meteo\]\(open-meteo\/\) \| beta \| none \| Weather \| 2 \|/);
});

test("the root README table and every plugin README match plugin-status.json", () => {
  const pluginStatuses = readPluginStatuses();
  const rootReadme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  assert.equal(applyStatusColumns(rootReadme, pluginStatuses), rootReadme, "run `npm run sync`");
  for (const pluginName of listPluginNames()) {
    const readmeText = readFileSync(join(REPO_ROOT, pluginName, "README.md"), "utf8");
    assert.equal(applyReadmeStatusLine(readmeText, pluginStatuses[pluginName]), readmeText, `${pluginName}: run \`npm run sync\``);
  }
});
