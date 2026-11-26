/**
 * ui-render plugin definition: rich visual output for graphrt agents. Each operation builds one graphrt UI block
 * (Adaptive Card, chart, table, KPI tiles or diagram), checks it with the same rules as the host (graphrt's `graphrt-ui`
 * crate) and returns it. graphrt Desktop renders the blocks in run results, chatbot conversations and "ask me first" steps.
 *
 * No network, no credentials, no files: the plugin only shapes and validates JSON (`localOnly`, `noCredentials`).
 */
import { uiOperations } from "./operations/ui-operations.mjs";

export const pluginDefinition = {
  name: "ui-render",
  version: "0.2.0",
  description: "Rich visual output for agents: Adaptive Cards (with inputs and buttons), bar/line/area/pie/donut charts, tables, KPI tiles and Mermaid diagrams, validated as graphrt UI blocks for the host to render",
  localOnly: true,
  noCredentials: true,
  limits: { timeout_ms: 30000, max_concurrency: 8 },
  createClient: () => ({}),
  operations: uiOperations,
};
