/**
 * The ready-made agents (agents/*.yaml, listed in graphrt-agents.json): each
 * checks the details first (a mistake ends in a plain message, with no file
 * and no number used), asks, then creates the invoice with the ready-made
 * template under the next number in the usual folder; what it sends to
 * check_values and render_pdf really behaves so. The generic checks of the file and of safe steps are
 * in scripts/test/plugin-agents.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { AS_NODE, SKIP_WITHOUT_LIBRARIES, readPageTexts, withDocumentRunner } from "./helpers.mjs";

const yaml = await import("yaml").catch(() => null);
const options = { skip: SKIP_WITHOUT_LIBRARIES || (yaml ? false : "npm packages are not installed") };
const pluginFile = (relativePath) => new URL(`../${relativePath}`, import.meta.url);
const { agents } = JSON.parse(await readFile(pluginFile("graphrt-agents.json"), "utf8"));
const INPUTS = {
  en: { client_name: "Northwind Analytics Ltd", client_address: "18 Harbour Street\nBristol BS1 4XY", tax_name: "VAT", tax_percent: 20, currency: "USD", seller_name: "Rina Wijaya", expected: ["INVOICE", "BILL TO", "Northwind Analytics Ltd", "18 Harbour Street", "VAT (20%)", "Rina Wijaya"], total: "845.40" },
  id: { client_name: "PT Maju Bersama", client_address: "", tax_name: "PPN", tax_percent: null, currency: "IDR", seller_name: "CV Kenanga Digital", expected: ["DITAGIHKAN KEPADA", "PT Maju Bersama", "CV Kenanga Digital", "Rp 3.050.000"], total: "3050000" },
};

const COLUMN_TITLES = { en: ["Description", "Quantity", "Unit", "Unit price"], id: ["Deskripsi", "Jumlah", "Satuan", "Harga satuan"] };

// What graphrt does with a node's config: a text that is exactly one {{#start.x#}} becomes that input, with its type.
function fillFromStart(value, inputs) {
  if (Array.isArray(value)) return value.map((entry) => fillFromStart(entry, inputs));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillFromStart(entry, inputs)]));
  const whole = typeof value === "string" ? /^\{\{#start\.([a-z_]+)#\}\}$/.exec(value) : null;
  return whole ? inputs[whole[1]] : value;
}

// The arguments graphrt passes to a plugin step: its config without the step's own fields, with the inputs filled in.
function readOperationArguments(node, inputs) {
  const { id: _id, type: _type, title: _title, on_error: _onError, ...config } = node;
  return fillFromStart(config, inputs);
}

test("the agents file lists an English and an Indonesian invoice agent", () => {
  assert.deepEqual(agents.map((agent) => [agent.id, agent.language, agent.workflow]), [["make-invoice", "en", "agents/make-invoice.yaml"], ["buat-invoice", "id", "agents/buat-invoice.yaml"]]);
});

for (const agent of agents) {
  test(`${agent.id}: checks the details first, asks, then creates the invoice under the next number in the usual folder, without an AI model`, options, async () => {
    const workflow = yaml.parse(await readFile(pluginFile(agent.workflow), "utf8"));
    const nodes = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
    const next = (id, handle) => workflow.graph.edges.find((edge) => edge.source === id && edge.handle === handle).target;
    // The one path that creates something, in order.
    const path = ["start"];
    for (const handle of [undefined, undefined, "ok", undefined, "create", undefined]) path.push(next(path.at(-1), handle));
    assert.deepEqual(path.map((id) => nodes.get(id).type), ["start", "document-templates.check_values", "if-else", "template-transform", "human-input", "document-templates.render_pdf", "template-transform"]);
    assert.ok(!workflow.graph.nodes.some((node) => node.type === "document-templates.next_number"), "no number is taken before the PDF is saved");
    // The check reads only, and checks exactly what the PDF step will be given.
    const checkNode = nodes.get("check_invoice");
    const renderNode = nodes.get("create_pdf");
    const { id: _checkId, type: _checkType, title: _checkTitle, ...checkConfig } = checkNode;
    const { id: _renderId, type: _renderType, title: _renderTitle, on_error: onError, ...renderConfig } = renderNode;
    assert.deepEqual(checkConfig, renderConfig);
    assert.deepEqual([renderConfig.template, renderConfig.number_pattern, renderConfig.values.number, renderConfig.folder, renderConfig.file_name, renderConfig.values.language], ["invoice", "INV-{YYYY}-{SEQ:4}", undefined, undefined, undefined, agent.language]);
    // A wrong detail ends in a message, before the approval; a failed PDF ends in a message too.
    assert.deepEqual(nodes.get("is_ok").cases.map((branch) => [branch.case_id, branch.conditions]), [["ok", [{ variable_selector: ["check_invoice", "data", "problem"], comparison_operator: "empty" }]]]);
    assert.equal(next("is_ok", "false"), "write_problem");
    assert.deepEqual(nodes.get("write_problem").variables, [{ variable: "problem", value_selector: ["check_invoice", "data", "problem"] }]);
    assert.deepEqual(onError, { strategy: "fail-branch" });
    assert.deepEqual(nodes.get(next("create_pdf", "fail-branch")).variables, [{ variable: "error", value_selector: ["create_pdf", "error_message"] }]);
    for (const outcome of ["write_summary", "write_cancelled", "write_problem", "write_failed"]) assert.equal(next(outcome, undefined), "result", outcome);
    assert.deepEqual(nodes.get("result").variables, [["write_summary", "output"], ["write_cancelled", "output"], ["write_problem", "output"], ["write_failed", "output"]]);
    // The approval shows the invoice in plain words with its number and total, never the raw data of the items.
    const approval = nodes.get("approve");
    assert.equal(approval.prompt.includes("start.items"), false);
    for (const shown of ["{{#list_details.output#}}", "{{#check_invoice.data.number#}}", "{{#check_invoice.data.totals.balance_due_text#}}"]) assert.ok(approval.prompt.includes(shown), shown);
    assert.deepEqual(approval.actions.map((action) => action.id), ["create", "cancel"]);
    assert.equal(nodes.get(next("approve", "cancel")).type, "template-transform", "cancelling creates nothing");
    assert.ok(!JSON.stringify(workflow).includes("llm"), "no model step");

    const inputs = Object.fromEntries(nodes.get("start").variables.map((variable) => [variable.variable, variable.default]));
    assert.deepEqual(Object.keys(inputs), ["client_name", "client_address", "items", "tax_name", "tax_percent", "currency", "seller_name"]);
    // The items are a list of rows; each column has a title in the agent's language and the right type.
    const itemColumns = nodes.get("start").variables.find((variable) => variable.variable === "items").json_schema.items.properties;
    assert.deepEqual(Object.entries(itemColumns).map(([name, column]) => [name, column.type]), [["description", "string"], ["quantity", "number"], ["unit", "string"], ["unit_price", "number"]]);
    assert.deepEqual(Object.values(itemColumns).map((column) => column.title), COLUMN_TITLES[agent.language]);
    for (const row of inputs.items) assert.deepEqual(Object.keys(row), Object.keys(itemColumns), "the example rows have exactly the columns");

    const { expected, total, ...given } = INPUTS[agent.language];
    await withDocumentRunner({}, async ({ runOperation, outputDirectory }) => {
      // The desktop test: an amount written in words. The check says so in plain words; no file, no number.
      const wrongItems = [{ description: "Jasa konsultasi", quantity: 2, unit: "jam", unit_price: "seratus ribu" }];
      const refused = await runOperation("check_values", readOperationArguments(checkNode, { ...inputs, ...given, items: wrongItems }), AS_NODE);
      assert.deepEqual([refused.data.ok, refused.data.problem], [false, "The unit price of item 1 must be a plain number such as 1500000 or 1500000.50 (no thousands separators or currency symbols), got \"seratus ribu\""]);
      assert.deepEqual(await readdir(outputDirectory), []);

      const checked = await runOperation("check_values", readOperationArguments(checkNode, { ...inputs, ...given }), AS_NODE);
      assert.deepEqual([checked.data.ok, checked.data.problem, checked.data.number, checked.data.totals.balance_due], [true, null, "INV-2026-0001", total]);
      assert.deepEqual(await readdir(outputDirectory), []);
      const result = await runOperation("render_pdf", readOperationArguments(renderNode, { ...inputs, ...given }), AS_NODE);
      assert.deepEqual([result.data.number, result.data.relative_path, result.data.totals.balance_due], ["INV-2026-0001", "2026/11/INV-2026-0001.pdf", total]);
      const [pageText] = await readPageTexts(await readFile(result.data.path));
      for (const text of [...expected, "INV-2026-0001"]) assert.ok(pageText.includes(text), `${text} in ${pageText}`);
    });
  });
}
