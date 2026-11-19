// graphrt plugin `mysql`. Never console.log: stdout carries the plugin protocol.
import { startPlugin } from "./lib/shared/operations.mjs";
import { pluginDefinition } from "./definition.mjs";

const closeConnectionsAndExit = async (exitCode) => {
  await pluginDefinition.closeAllConnections().catch((closeError) => console.error(`[mysql] closing connections failed: ${closeError.message}`));
  process.exit(exitCode);
};
for (const signalName of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signalName, () => closeConnectionsAndExit(0));

await startPlugin(pluginDefinition);
// stdin ended: the host is done with this plugin.
await closeConnectionsAndExit(0);
