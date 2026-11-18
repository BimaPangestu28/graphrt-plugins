// Test worker: one OS process acting like a plugin instance on a shared store directory.
// Usage: node concurrent-worker.mjs <storeDirectory> '{"increments": n, "ids": [...]}'
// Prints `{newIds}` (the ids filter_unseen returned as new to this process) on stdout.
import { createOperationRunner } from "../../lib/shared/operations.mjs";
import { createStateStoreDefinition } from "../../definition.mjs";

const [storeDirectory, taskJson] = process.argv.slice(2);
const task = JSON.parse(taskJson);
const runOperation = createOperationRunner(createStateStoreDefinition(), { STATE_STORE_DIR: storeDirectory });

const newIds = [];
for (let round = 0; round < task.increments; round += 1) {
  await runOperation("increment", { namespace: "proc", key: "count" }, { source: "node" });
  const idWindow = task.ids.slice((round * 7) % task.ids.length).concat(task.ids).slice(0, 10);
  const filtered = await runOperation("filter_unseen", { namespace: "proc", ids: idWindow }, { source: "node" });
  newIds.push(...filtered.data.new_ids);
}
// Cover every id once at the end so the union is the full list.
const finalFilter = await runOperation("filter_unseen", { namespace: "proc", ids: task.ids }, { source: "node" });
newIds.push(...finalFilter.data.new_ids);
process.stdout.write(JSON.stringify({ newIds }));
