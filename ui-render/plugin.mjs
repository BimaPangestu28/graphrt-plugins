// graphrt plugin `ui-render`. Never console.log: stdout carries the plugin protocol.
//
// Nodes run like every plugin's (outputs `data`, `next_cursor`). Tools differ: the model gets a one-line summary
// and the block goes only into the structured result, which graphrt's agent node collects in its `ui` output
// for the host to render. Sending the whole card or chart back to the model would only cost tokens.
import { Plugin } from "./lib/shared/graphrt-plugin.mjs";
import { createOperationRunner, resolveToolDeadlineMs } from "./lib/shared/operations.mjs";
import { pluginDefinition } from "./definition.mjs";
import { summarizeForModel } from "./operations/ui-operations.mjs";

const runOperation = createOperationRunner(pluginDefinition, process.env);
const toolDeadlineMs = resolveToolDeadlineMs(pluginDefinition);
const plugin = new Plugin(pluginDefinition.name);
for (const operation of pluginDefinition.operations) {
  plugin.node(`${pluginDefinition.name}.${operation.name}`, async (ctx, req) => ({
    outputs: await runOperation(operation.name, req.config, { source: "node", signal: ctx.signal }),
  }));
  plugin.tool({ name: operation.name, description: operation.description, parameters: operation.parameters }, async (toolArguments) => {
    const { data: block } = await runOperation(operation.name, toolArguments, { source: "tool", signal: AbortSignal.timeout(toolDeadlineMs) });
    return { text: summarizeForModel(block), data: block };
  });
}
plugin.run();
