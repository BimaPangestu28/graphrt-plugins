// graphrt plugin `whatsapp-web`. Never console.log: stdout carries the plugin protocol.
import { startPlugin } from "./lib/shared/operations.mjs";
import { installShutdownHandlers } from "./lib/shutdown.mjs";
import { pluginDefinition } from "./definition.mjs";

const shutdown = installShutdownHandlers({ closeAllClients: pluginDefinition.closeAllClients });
await startPlugin(pluginDefinition);
await shutdown("host closed the connection");
