// plugin.mjs over the real stdio protocol: tool results carry the block as data and only a summary as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

function startPlugin() {
  const child = spawn(process.execPath, [join(import.meta.dirname, "..", "plugin.mjs")], { stdio: ["pipe", "pipe", "inherit"], env: {} });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { call, stop: () => child.stdin.end() };
}

test("tool.call returns a summary for the model and the block as data", async () => {
  const plugin = startPlugin();
  try {
    const init = await plugin.call("initialize", { protocol_version: 1 });
    assert.equal(init.result.tools.length, 5);
    const reply = await plugin.call("tool.call", {
      name: "show_stats",
      arguments: { heading: "This week", items: [{ label: "Orders", value: 12 }] },
    });
    assert.match(reply.result.text, /^Shown to the user: 1 KPI tile "This week"/);
    assert.ok(!reply.result.text.includes("Orders"), "the model does not get the data again");
    assert.equal(reply.result.data.$ui, "stats");
    const bad = await plugin.call("tool.call", { name: "show_chart", arguments: { chart_type: "pie", x_values: ["a"], series: [{ name: "s", values: [-1] }] } });
    assert.equal(bad.error.data.kind, "invalid_input");
    assert.match(bad.error.message, /0 or more/);
    const node = await plugin.call("node.run", { kind: "ui-render.show_table", request_id: "r1", config: { rows: [{ a: 1 }] } });
    assert.equal(node.result.outputs.data.$ui, "table");
  } finally {
    plugin.stop();
  }
});
