import { test } from "node:test";
import assert from "node:assert/strict";
import { listPluginNames } from "../lib/plugin-package.mjs";
import { MAX_DISPLAY_NAME_LENGTH, displayNameFor, readPluginDisplayNames } from "../lib/plugin-names.mjs";

test("every plugin has exactly one display name in plugin-names.json", () => {
  const displayNames = readPluginDisplayNames();
  assert.deepEqual(Object.keys(displayNames).sort(), listPluginNames().sort());
});

test("display names are short, trimmed and free of control characters", () => {
  for (const [pluginName, displayName] of Object.entries(readPluginDisplayNames())) {
    assert.equal(typeof displayName, "string", pluginName);
    assert.equal(displayName, displayName.trim(), pluginName);
    assert.ok(displayName.length > 0 && displayName.length <= MAX_DISPLAY_NAME_LENGTH, pluginName);
    assert.doesNotMatch(displayName, /[\u0000-\u001f\u007f-\u009f]/, pluginName);
  }
});

test("looks up a plugin's display name and refuses a plugin without one", () => {
  assert.equal(displayNameFor("currency-rates"), "Currency Rates");
  assert.equal(displayNameFor("github"), "GitHub");
  assert.throws(() => displayNameFor("ghost"), /ghost: no entry in plugin-names.json/);
});
