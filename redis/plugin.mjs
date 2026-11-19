// graphrt plugin `redis`. Never console.log: stdout carries the plugin protocol.
import { startPlugin } from "./lib/shared/operations.mjs";
import { installShutdownHandlers } from "./lib/shutdown.mjs";
import { pluginDefinition } from "./definition.mjs";

const shutdown = installShutdownHandlers({
  pluginName: "redis",
  closeAllClients: pluginDefinition.closeAllClients,
  waitForRunningOperations: pluginDefinition.waitForRunningOperations,
});
await startPlugin(pluginDefinition);
// stdin ended: operations still running finish (bounded wait) and reply before the connections close.
await shutdown("host closed the connection", { letRunningFinish: true });
