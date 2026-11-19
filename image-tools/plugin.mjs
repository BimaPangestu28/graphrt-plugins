// graphrt plugin `image-tools`. Never console.log: stdout carries the plugin protocol.
import { startPlugin } from "./lib/shared/operations.mjs";
import { pluginDefinition } from "./definition.mjs";

startPlugin(pluginDefinition);
