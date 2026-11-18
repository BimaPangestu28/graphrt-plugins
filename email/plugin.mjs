// graphrt plugin `email`. Never console.log: stdout carries the plugin protocol.
import { startPlugin } from "./lib/shared/operations.mjs";
import { pluginDefinition } from "./definition.mjs";

await startPlugin(pluginDefinition);
