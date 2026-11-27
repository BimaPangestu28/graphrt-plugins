/**
 * The ready-made agents (agents/*.yaml, listed in graphrt-agents.json): each
 * asks first, takes a number, creates the invoice with the ready-made
 * template in the usual folder, and what it sends to render_pdf really
 * produces an invoice. The generic checks of the file and of safe steps are
 * in scripts/test/plugin-agents.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AS_NODE, SKIP_WITHOUT_LIBRARIES, readPageTexts, withDocumentRunner } from "./helpers.mjs";

const yaml = await import("yaml").catch(() => null);
const options = { skip: SKIP_WITHOUT_LIBRARIES || (yaml ? false : "npm packages are not installed") };
const pluginFile = (relativePath) => new URL(`../${relativePath}`, import.meta.url);
const { agents } = JSON.parse(await readFile(pluginFile("graphrt-agents.json"), "utf8"));
const INPUTS = {
  en: { client_name: "Northwind Analytics Ltd", client_address: "18 Harbour Street\nBristol BS1 4XY", tax_name: "VAT", tax_percent: 20, currency: "USD", seller_name: "Rina Wijaya", expected: ["INVOICE", "BILL TO", "Northwind Analytics Ltd", "18 Harbour Street", "VAT (20%)", "Rina Wijaya"], total: "845.40" },
  id: { client_name: "PT Maju Bersama", client_address: "", tax_name: "PPN", tax_percent: null, currency: "IDR", seller_name: "CV Kenanga Digital", expected: ["DITAGIHKAN KEPADA", "PT Maju Bersama", "CV Kenanga Digital", "Rp 3.050.000"], total: "3050000" },
};

// What graphrt does with a node's config: a text that is exactly one {{#start.x#}} becomes that input, with its type.
function fillFromStart(value, inputs, numberResult) {
  if (Array.isArray(value)) return value.map((entry) => fillFromStart(entry, inputs, numberResult));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillFromStart(entry, inputs, numberResult)]));
  const whole = typeof value === "string" ? /^\{\{#(start|take_number)\.([a-z_.]+)#\}\}$/.exec(value) : null;
  if (!whole) return value;
  return whole[1] === "start" ? inputs[whole[2]] : numberResult.number;
}

test("the agents file lists an English and an Indonesian invoice agent", () => {
  assert.deepEqual(agents.map((agent) => [agent.id, agent.language, agent.workflow]), [["make-invoice", "en", "agents/make-invoice.yaml"], ["buat-invoice", "id", "agents/buat-invoice.yaml"]]);
});

for (const agent of agents) {
  test(`${agent.id}: asks first, takes a number, then creates the invoice in the usual folder, without an AI model`, options, async () => {
    const workflow = yaml.parse(await readFile(pluginFile(agent.workflow), "utf8"));
    const nodes = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
    // The one path that creates something, in order.
    const next = (id, handle) => workflow.graph.edges.find((edge) => edge.source === id && (handle === undefined || edge.handle === handle)).target;
    const path = ["start"];
    for (const handle of [undefined, "create", undefined, undefined]) path.push(next(path.at(-1), handle));
    assert.deepEqual(path.map((id) => nodes.get(id).type), ["start", "human-input", "document-templates.next_number", "document-templates.render_pdf", "template-transform"]);
    assert.deepEqual(nodes.get("approve").actions.map((action) => action.id), ["create", "cancel"]);
    assert.equal(nodes.get(next("approve", "cancel")).type, "template-transform", "cancelling creates nothing");
    assert.ok(!JSON.stringify(workflow).includes("llm"), "no model step");

    const inputs = Object.fromEntries(nodes.get("start").variables.map((variable) => [variable.variable, variable.default]));
    assert.deepEqual(Object.keys(inputs), ["client_name", "client_address", "items", "tax_name", "tax_percent", "currency", "seller_name"]);
    const renderNode = nodes.get("create_pdf");
    assert.deepEqual([renderNode.template, renderNode.folder, renderNode.file_name, renderNode.values.language], ["invoice", undefined, undefined, agent.language]);

    const { expected, total, ...given } = INPUTS[agent.language];
    await withDocumentRunner({}, async ({ runOperation }) => {
      const number = await runOperation("next_number", { pattern: nodes.get("take_number").pattern }, AS_NODE);
      const result = await runOperation("render_pdf", { template: renderNode.template, values: fillFromStart(renderNode.values, { ...inputs, ...given }, number.data) }, AS_NODE);
      assert.deepEqual([result.data.relative_path, result.data.totals.balance_due], ["2026/11/INV-2026-0001.pdf", total]);
      const [pageText] = await readPageTexts(await readFile(result.data.path));
      for (const text of expected) assert.ok(pageText.includes(text), `${text} in ${pageText}`);
    });
  });
}
