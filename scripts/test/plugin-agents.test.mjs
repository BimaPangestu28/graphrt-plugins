import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";
import { AGENTS_FILE_NAME, MAX_AGENTS_FILE_BYTES, MAX_AGENT_WORKFLOW_BYTES, SAFE_CORE_NODE_KINDS, findAgentProblems, findWorkflowFileProblems, findWorkflowProblems, parsePluginAgents } from "../lib/plugin-agents.mjs";
import { listPluginNames } from "../lib/plugin-package.mjs";

const VALID_AGENT = { id: "make-invoice", title: "Make an invoice", description: "Asks for the client, then makes the PDF.", language: "en", workflow: "agents/make-invoice.yaml" };

function workflow(nodes, edges) {
  return { version: "1", name: "t", graph: { nodes, edges: edges.map(([source, target, handle]) => ({ source, target, ...(handle ? { handle } : {}) })) } };
}

const START = { id: "start", type: "start" };
const ASK = { id: "ask", type: "human-input", actions: [{ id: "yes" }, { id: "no" }] };
const NUMBER = { id: "number", type: "acme.next_number" };
const RENDER = { id: "render", type: "acme.render_pdf" };
const END = { id: "end", type: "end" };

test("an agents item needs an id, texts people can read and a workflow path inside the plugin", () => {
  for (const item of [VALID_AGENT, { ...VALID_AGENT, language: undefined }, { ...VALID_AGENT, workflow: "a.yaml" }, { ...VALID_AGENT, workflow: "agents/id/buat-invoice_2.yaml" }]) assert.deepEqual(findAgentProblems(item), [], JSON.stringify(item));
  const invalid = [
    [null, /must be an object/],
    [{ ...VALID_AGENT, id: "Make Invoice" }, /needs an `id`/],
    [{ ...VALID_AGENT, id: "x".repeat(65) }, /needs an `id`/],
    [{ ...VALID_AGENT, title: "" }, /needs a `title`/],
    [{ ...VALID_AGENT, title: "x".repeat(121) }, /`title` is longer than 120/],
    [{ ...VALID_AGENT, description: undefined }, /needs a `description`/],
    [{ ...VALID_AGENT, description: "y".repeat(401) }, /`description` is longer than 400/],
    [{ ...VALID_AGENT, description: "a\u0007b" }, /control character/],
    [{ ...VALID_AGENT, language: "EN" }, /`language` must be two lowercase letters/],
    [{ ...VALID_AGENT, language: "eng" }, /`language`/],
    [{ ...VALID_AGENT, prompt: "Make an invoice" }, /unknown field `prompt`/],
    ...["/etc/passwd.yaml", "../other/agent.yaml", "agents/../../x.yaml", "agents\\x.yaml", "agents/x.yml", "agents/x.json", "agents//x.yaml", "./x.yaml", "agents/x y.yaml", 7].map((path) => [{ ...VALID_AGENT, workflow: path }, /`workflow` must be a relative \.yaml path/]),
  ];
  for (const [item, pattern] of invalid) assert.match(findAgentProblems(item).join("; "), pattern, JSON.stringify(item));
});

test("an agents file keeps its valid items and names every problem", () => {
  const parsed = parsePluginAgents(JSON.stringify({ agents: [VALID_AGENT, { ...VALID_AGENT, id: "second", title: "" }, "x", VALID_AGENT, { ...VALID_AGENT, id: "third" }] }));
  assert.deepEqual(parsed.agents.map((item) => item.id), ["make-invoice", "third"]);
  assert.deepEqual(parsed.problems, ["second: needs a `title`", "agents[2]: must be an object", "make-invoice: is listed twice"]);
  for (const [unusable, pattern] of [["{", /not valid JSON/], ["[]", /`agents` list/], [JSON.stringify({ agents: {} }), /`agents` list/], [`{"agents":[],"pad":"${"x".repeat(MAX_AGENTS_FILE_BYTES)}"}`, /larger than 65536 bytes/]]) {
    const result = parsePluginAgents(unusable);
    assert.deepEqual(result.agents, []);
    assert.match(result.problems.join("; "), pattern);
  }
  assert.match(parsePluginAgents(JSON.stringify({ agents: [], templates: [] })).problems.join("; "), /unknown field `templates`/);
  assert.match(parsePluginAgents(JSON.stringify({ agents: Array.from({ length: 21 }, (_, index) => ({ ...VALID_AGENT, id: `a-${index}` })) })).problems.join("; "), /at most 20 agents/);
});

test("a workflow file must be a plain, small file in plain folders of the plugin", () => {
  const pluginDirectory = mkdtempSync(join(tmpdir(), "graphrt-agents-test-"));
  try {
    mkdirSync(join(pluginDirectory, "agents"));
    mkdirSync(join(pluginDirectory, "elsewhere"));
    writeFileSync(join(pluginDirectory, "agents", "ok.yaml"), "version: '1'\n");
    writeFileSync(join(pluginDirectory, "agents", "big.yaml"), "#".repeat(MAX_AGENT_WORKFLOW_BYTES + 1));
    writeFileSync(join(pluginDirectory, "elsewhere", "target.yaml"), "version: '1'\n");
    assert.deepEqual(findWorkflowFileProblems(pluginDirectory, "agents/ok.yaml"), []);
    assert.match(findWorkflowFileProblems(pluginDirectory, "agents/missing.yaml").join(), /does not exist/);
    assert.match(findWorkflowFileProblems(pluginDirectory, "agents/big.yaml").join(), /larger than 65536 bytes/);
    assert.match(findWorkflowFileProblems(pluginDirectory, "agents").join(), /plain file/);
    // Windows needs a privilege for links; the check itself is the same lstat on every system.
    if (process.platform !== "win32") {
      symlinkSync(join(pluginDirectory, "elsewhere", "target.yaml"), join(pluginDirectory, "agents", "link.yaml"));
      symlinkSync(join(pluginDirectory, "elsewhere"), join(pluginDirectory, "linked"));
      assert.match(findWorkflowFileProblems(pluginDirectory, "agents/link.yaml").join(), /no links/);
      assert.match(findWorkflowFileProblems(pluginDirectory, "linked/target.yaml").join(), /no links/);
    }
  } finally {
    rmSync(pluginDirectory, { recursive: true, force: true });
  }
});

test("a ready-made workflow uses only safe steps, and asks before every step that creates or changes something", () => {
  const approvedFirst = workflow([START, ASK, NUMBER, RENDER, END], [["start", "ask"], ["ask", "number", "yes"], ["number", "render"], ["render", "end"], ["ask", "end", "no"]]);
  assert.deepEqual(findWorkflowProblems(approvedFirst, "acme"), []);
  const readsFirst = workflow([START, { id: "look", type: "acme.list_templates" }, { id: "one", type: "acme.get" }, ASK, RENDER, END], [["start", "look"], ["look", "one"], ["one", "ask"], ["ask", "render", "yes"], ["render", "end"]]);
  assert.deepEqual(findWorkflowProblems(readsFirst, "acme"), []);

  const numberBeforeAsking = workflow([START, NUMBER, ASK, RENDER, END], [["start", "number"], ["number", "ask"], ["ask", "render", "yes"], ["render", "end"]]);
  assert.match(findWorkflowProblems(numberBeforeAsking, "acme").join("; "), /^step `number` \(acme\.next_number\) creates or changes something and can run before the person approves/);
  const sidePath = workflow([START, ASK, { id: "branch", type: "if-else" }, RENDER, END], [["start", "ask"], ["start", "branch"], ["ask", "render", "yes"], ["branch", "render", "false"], ["render", "end"]]);
  assert.match(findWorkflowProblems(sidePath, "acme").join("; "), /step `render`/);
  const checksFirst = workflow([START, { id: "check", type: "acme.check_values" }, ASK, RENDER, END], [["start", "check"], ["check", "ask"], ["ask", "render", "yes"], ["render", "end"]]);
  assert.deepEqual(findWorkflowProblems(checksFirst, "acme"), []);
  // A reading verb first is not enough when the name also sends, as graphrt Desktop decides too.
  assert.match(findWorkflowProblems(workflow([START, { id: "x", type: "acme.check_and_send" }, END], [["start", "x"], ["x", "end"]]), "acme").join("; "), /step `x`/);
  // "listing" and "getter" are not read operations; only whole words before `_` count.
  assert.match(findWorkflowProblems(workflow([START, { id: "x", type: "acme.listing_delete" }, END], [["start", "x"], ["x", "end"]]), "acme").join("; "), /step `x`/);

  for (const kind of ["http-request", "code", "llm", "agent", "tool", "shell-exec.run", "other.render_pdf", "iteration", "acme.", "acmex.read"]) {
    const problems = findWorkflowProblems(workflow([START, ASK, { id: "odd", type: kind }, END], [["start", "ask"], ["ask", "odd", "yes"], ["odd", "end"]]), "acme");
    assert.match(problems.join("; "), /step `odd` uses/, kind);
  }
  for (const kind of SAFE_CORE_NODE_KINDS.filter((name) => name !== "start")) {
    assert.deepEqual(findWorkflowProblems(workflow([START, { id: "core", type: kind }, END], [["start", "core"], ["core", "end"]]), "acme"), [], kind);
  }
  const selfAnswering = workflow([START, { ...ASK, expire_after_ms: 1000 }, RENDER, END], [["start", "ask"], ["ask", "render", "yes"]]);
  assert.match(findWorkflowProblems(selfAnswering, "acme").join("; "), /step `ask` must wait for the person without a time limit/);
  assert.match(findWorkflowProblems(workflow([ASK, RENDER], [["ask", "render"]]), "acme").join("; "), /exactly one `start`/);
  assert.match(findWorkflowProblems({ graph: {} }, "acme").join("; "), /graph\.nodes/);
  assert.match(findWorkflowProblems(workflow([START, { id: 7 }], []), "acme").join("; "), /`id` and a `type`/);
});

test("a label says what to fill in, not whether it is optional or required: the app adds that marker itself", () => {
  const withLabels = (labels, fieldLabels = []) => workflow([
    { id: "start", type: "start", variables: labels.map((label, index) => ({ variable: `v${index}`, type: "text-input", label })) },
    { ...ASK, form: { fields: fieldLabels.map((label, index) => ({ name: `f${index}`, label })) } },
    END,
  ], [["start", "ask"], ["ask", "end", "yes"]]);
  const fine = ["Client address", "Tax percent (leave empty for no tax)", "Currency (USD, EUR, SGD, IDR...)", "Optional extras to mention", "Tarif pajak dalam persen (kosongkan bila tanpa pajak)", "Dokumen wajib pajak", "Rating * weight"];
  assert.deepEqual(findWorkflowProblems(withLabels(fine, ["Comment"]), "acme"), []);
  assert.deepEqual(findWorkflowProblems(workflow([{ id: "start", type: "start", variables: [{ variable: "a", type: "number" }] }, END], [["start", "end"]]), "acme"), []);
  for (const label of ["Client address (optional)", "Alamat klien (opsional)", "Client name (required)", "Nama klien (wajib)", "Nama klien (Wajib diisi)", "Client name [Optional]", "Note ( OPTIONAL )", "Client name (mandatory)", "Client name *"]) {
    assert.match(findWorkflowProblems(withLabels(["Client name", label]), "acme").join("; "), /^step `start`: the label ".*" says whether the input must be filled in/, label);
    assert.match(findWorkflowProblems(withLabels([], [label]), "acme").join("; "), /^step `ask`: the label/, label);
  }
});

test("every plugin's graphrt-agents.json is valid, and its workflows are fit to run as written", (context) => {
  const pluginsWithAgents = listPluginNames().filter((pluginName) => existsSync(join(REPO_ROOT, pluginName, AGENTS_FILE_NAME)));
  assert.ok(pluginsWithAgents.includes("document-templates"));
  let skippedPlugins = 0;
  for (const pluginName of pluginsWithAgents) {
    const pluginDirectory = join(REPO_ROOT, pluginName);
    const parsed = parsePluginAgents(readFileSync(join(pluginDirectory, AGENTS_FILE_NAME), "utf8"));
    assert.deepEqual(parsed.problems, [], pluginName);
    assert.ok(parsed.agents.length > 0, `${pluginName}: an agents file needs at least one agent`);
    for (const agent of parsed.agents) assert.deepEqual(findWorkflowFileProblems(pluginDirectory, agent.workflow), [], `${pluginName}: ${agent.id}`);
    // The YAML reader is the plugin's own development dependency (`yaml`), present after its `npm ci`.
    let yaml;
    try {
      yaml = createRequire(join(pluginDirectory, "package.json"))("yaml");
    } catch (loadError) {
      assert.ok(!existsSync(join(pluginDirectory, "node_modules")), `${pluginName} has ready-made agents, so its package.json needs \`yaml\` in devDependencies (${loadError.code})`);
      skippedPlugins += 1;
      continue;
    }
    for (const agent of parsed.agents) {
      const document = yaml.parse(readFileSync(join(pluginDirectory, agent.workflow), "utf8"));
      assert.deepEqual(findWorkflowProblems(document, pluginName), [], `${pluginName}: ${agent.workflow}`);
      assert.equal(document.name, agent.id, `${pluginName}: the workflow of ${agent.id} is named after the agent`);
    }
  }
  if (skippedPlugins > 0) context.diagnostic(`${skippedPlugins} plugin(s) without installed npm packages: their workflows were not read`);
});
