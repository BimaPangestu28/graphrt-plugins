import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { humanizeKey, inferColumns, seriesFromRows, summarizeForModel } from "../operations/ui-operations.mjs";

const runOperation = createOperationRunner(pluginDefinition, {});
const asNode = { source: "node" };

test("show_chart builds a chart block from categories and series", async () => {
  const { data } = await runOperation("show_chart", {
    chart_type: "bar", heading: "Sales", x_values: ["Jan", "Feb"], series: [{ name: "2026", values: [120, 150] }],
    y_format: "currency", currency: "IDR", subtitle: "",
  }, asNode);
  assert.deepEqual(data, {
    $ui: "chart", version: 1, type: "bar", title: "Sales",
    x: { values: ["Jan", "Feb"] }, y: { format: "currency", currency: "IDR" }, series: [{ name: "2026", values: [120, 150] }],
  });
});

test("show_chart turns rows into series, numbers given as strings included", async () => {
  const rows = [{ month: "Jan", revenue: "1200", orders: 10 }, { month: "Feb", revenue: 1500, orders: null }];
  const { data } = await runOperation("show_chart", { chart_type: "line", rows, x_key: "month", y_keys: ["revenue", "orders"] }, asNode);
  assert.deepEqual(data.x.values, ["Jan", "Feb"]);
  assert.deepEqual(data.series, [{ name: "Revenue", values: [1200, 1500] }, { name: "Orders", values: [10, null] }]);
});

test("show_chart explains what to fix", async () => {
  const mismatch = { chart_type: "bar", x_values: ["a", "b"], series: [{ name: "s", values: [1] }] };
  await assert.rejects(runOperation("show_chart", mismatch, asNode), { kind: "invalid_input", message: /one value \(or null\) per category/ });
  await assert.rejects(runOperation("show_chart", { chart_type: "radar", x_values: ["a"], series: [] }, asNode), { kind: "invalid_input" });
  await assert.rejects(runOperation("show_chart", { chart_type: "bar" }, asNode), { message: /x_values and series, or rows/ });
  const both = { chart_type: "bar", rows: [{ a: 1 }], x_key: "a", y_keys: ["a"], x_values: ["a"] };
  await assert.rejects(runOperation("show_chart", both, asNode), { message: /not both/ });
  await assert.rejects(runOperation("show_chart", { chart_type: "bar", rows: [{ m: "Jan", n: "lots" }], x_key: "m", y_keys: ["n"] }, asNode), {
    message: /rows\[0\]\.n is `lots`, not a number/,
  });
});

test("show_table infers columns when none are given", async () => {
  const rows = [{ product: "Kopi", units_sold: 12 }, { product: "Teh", units_sold: 7, note: "promo" }];
  const { data } = await runOperation("show_table", { rows, heading: "Products" }, asNode);
  assert.deepEqual(data.columns, [
    { key: "product", label: "Product" },
    { key: "units_sold", label: "Units sold", format: "number" },
    { key: "note", label: "Note" },
  ]);
  assert.equal(data.title, "Products");
  await assert.rejects(runOperation("show_table", { rows: [{}] }, asNode), { message: /no fields/ });
});

test("show_stats and show_adaptive_card validate their payloads", async () => {
  const { data } = await runOperation("show_stats", { items: [{ label: "Orders", value: 12, delta: 3 }] }, asNode);
  assert.equal(data.$ui, "stats");
  await assert.rejects(runOperation("show_stats", { items: [{ label: "Orders", value: { n: 1 } }] }, asNode), { kind: "invalid_input" });
  const card = { type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "Hello ${name}" }] };
  await assert.rejects(runOperation("show_adaptive_card", { card }, asNode), { message: /template expressions/ });
  const cardFromTemplate = JSON.stringify({ type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "Hi" }] });
  const { data: block } = await runOperation("show_adaptive_card", { card: cardFromTemplate }, asNode);
  assert.equal(block.card.body[0].text, "Hi", "a JSON string from a workflow template is parsed");
});

test("the model gets a summary, not the data", () => {
  const chart = { $ui: "chart", type: "bar", title: "Sales", x: { values: ["a", "b"] }, series: [{ name: "s", values: [1, 2] }] };
  assert.equal(summarizeForModel(chart), 'Shown to the user: bar chart "Sales" with 1 series over 2 categories. They can see it, so do not repeat its contents; add only your conclusions.');
  assert.match(summarizeForModel({ $ui: "table", rows: [{}], columns: [{}, {}] }), /table with 1 row and 2 columns/);
  assert.match(summarizeForModel({ $ui: "stats", items: [{}] }), /1 KPI tile\./);
  assert.match(summarizeForModel({ $ui: "adaptive_card", title: "Refund" }), /Adaptive Card "Refund"/);
});

test("helpers", () => {
  assert.equal(humanizeKey("monthlyRevenue"), "Monthly revenue");
  assert.equal(humanizeKey("units-sold"), "Units sold");
  assert.deepEqual(inferColumns([{ a: 1 }, { a: null }]), [{ key: "a", label: "A", format: "number" }]);
  assert.throws(() => seriesFromRows([{ a: 1 }], "a", ["b"]), /no row has the field `b`/);
});

test("manifest: local only, four nodes and tools", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: false, secrets: false, env: [] });
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["show_adaptive_card", "show_chart", "show_table", "show_stats"]);
  assert.deepEqual(manifest.nodes.map((node) => node.kind), ["ui-render.show_adaptive_card", "ui-render.show_chart", "ui-render.show_table", "ui-render.show_stats"]);
});
