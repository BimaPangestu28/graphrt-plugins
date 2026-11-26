import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifestTriggers, renderTriggerSection } from "../lib/plugin-triggers.mjs";

const definition = (triggers) => ({ name: "acme", operations: [{ name: "wait_for_thing" }, { name: "other" }], triggers });

test("a definition without triggers adds nothing", () => {
  assert.deepEqual(buildManifestTriggers({ name: "acme", operations: [] }), []);
  assert.deepEqual(renderTriggerSection({ name: "acme", operations: [] }), []);
});

test("turns a trigger's watch operation into the node kind and keeps its config and outputs", () => {
  const [trigger] = buildManifestTriggers(definition([{
    id: "thing_happened",
    title: "When a thing happens",
    description: "A thing | happened",
    watch: "wait_for_thing",
    config: { timeout_seconds: 240 },
    outputs: [{ name: "thing_id", type: "string", description: "Which thing" }],
  }]));
  assert.deepEqual(trigger, {
    id: "thing_happened",
    title: "When a thing happens",
    description: "A thing | happened",
    watch: "acme.wait_for_thing",
    config: { timeout_seconds: 240 },
    outputs: [{ name: "thing_id", type: "string", description: "Which thing" }],
  });
  const minimal = buildManifestTriggers(definition([{ id: "t", title: "T", watch: "other" }]))[0];
  assert.deepEqual(minimal, { id: "t", title: "T", watch: "acme.other", config: {}, outputs: [] });
});

test("refuses triggers the manifest would reject", () => {
  const cases = [
    [{ id: "Bad Id", title: "T", watch: "other" }, /`id`/],
    [{ id: "t", title: " ", watch: "other" }, /`title`/],
    [{ id: "t", title: "T", watch: "missing" }, /`watch`/],
    [{ id: "t", title: "T", watch: "other", config: [] }, /`config`/],
    [{ id: "t", title: "T", watch: "other", outputs: [{ name: "x", type: "text" }] }, /output/],
  ];
  for (const [trigger, message] of cases) assert.throws(() => buildManifestTriggers(definition([trigger])), message);
  const twice = { id: "t", title: "T", watch: "other" };
  assert.throws(() => buildManifestTriggers(definition([twice, twice])), /duplicate/);
});

test("lists triggers in OPERATIONS.md", () => {
  const lines = renderTriggerSection(definition([{ id: "t", title: "When | T", watch: "other", outputs: [{ name: "a", type: "string" }] }]));
  assert.equal(lines[0], "## Triggers");
  assert.ok(lines.includes("| `t` | When \\| T | `acme.other` |  | `a` |"));
});
