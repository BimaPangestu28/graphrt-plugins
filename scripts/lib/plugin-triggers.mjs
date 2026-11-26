/**
 * Triggers a plugin definition declares: events a host (graphrt Desktop) starts workflows on.
 *
 * A definition lists them as
 *   triggers: [{ id, title, description?, watch, config?, outputs? }]
 * where `watch` is the name of one of its operations. The host calls that operation's node
 * (`<plugin>.<watch>`) outside any run, again and again, with `config` plus `cursor`, and reads
 * `data.events` (one run's inputs each) and `data.cursor` from it. The manifest field is
 * graphrt's `triggers` (docs/plugin-manifest.md in Graphrt/graphrt).
 */

const TRIGGER_ID = /^[a-z0-9_-]{1,64}$/;
const OUTPUT_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "array[string]", "array[number]", "array[object]", "any"]);

/**
 * The manifest `triggers` of a definition, checked.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns Manifest trigger entries, or [] when the definition declares none (Array<object>)
 * @throws Error - When an id, title, watch operation, config or output is invalid
 */
export function buildManifestTriggers(pluginDefinition) {
  const triggers = pluginDefinition.triggers ?? [];
  if (!Array.isArray(triggers)) throw new Error(`${pluginDefinition.name}: \`triggers\` must be an array`);
  const operationNames = new Set(pluginDefinition.operations.map((operation) => operation.name));
  const seenIds = new Set();
  return triggers.map((trigger) => {
    const where = `${pluginDefinition.name}: trigger \`${trigger?.id}\``;
    if (typeof trigger?.id !== "string" || !TRIGGER_ID.test(trigger.id)) throw new Error(`${where}: \`id\` must match ${TRIGGER_ID}`);
    if (seenIds.has(trigger.id)) throw new Error(`${where}: duplicate id`);
    seenIds.add(trigger.id);
    if (typeof trigger.title !== "string" || !trigger.title.trim() || /[\u0000-\u001f\u007f]/.test(trigger.title)) {
      throw new Error(`${where}: \`title\` must be non-blank text without control characters`);
    }
    if (!operationNames.has(trigger.watch)) throw new Error(`${where}: \`watch\` must name one of the plugin's operations`);
    const config = trigger.config ?? {};
    if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error(`${where}: \`config\` must be an object`);
    const outputs = (trigger.outputs ?? []).map((output) => {
      if (typeof output?.name !== "string" || !output.name || !OUTPUT_TYPES.has(output.type)) {
        throw new Error(`${where}: each output needs a \`name\` and a \`type\` (${[...OUTPUT_TYPES].join(", ")})`);
      }
      return output.description ? { name: output.name, type: output.type, description: output.description } : { name: output.name, type: output.type };
    });
    return {
      id: trigger.id,
      title: trigger.title,
      ...(trigger.description ? { description: trigger.description } : {}),
      watch: `${pluginDefinition.name}.${trigger.watch}`,
      config,
      outputs,
    };
  });
}

/**
 * The "Triggers" section of OPERATIONS.md, or no lines when there are none.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @returns Markdown lines (Array<string>)
 */
export function renderTriggerSection(pluginDefinition) {
  const triggers = buildManifestTriggers(pluginDefinition);
  if (triggers.length === 0) return [];
  const rows = triggers.map((trigger) => {
    const outputs = trigger.outputs.map((output) => `\`${output.name}\``).join(", ");
    const description = (trigger.description ?? "").replaceAll("|", "\\|");
    return `| \`${trigger.id}\` | ${trigger.title.replaceAll("|", "\\|")} | \`${trigger.watch}\` | ${description} | ${outputs} |`;
  });
  return [
    "## Triggers",
    "",
    "Events a host such as graphrt Desktop starts workflows on: it long-polls the watch node outside any run and starts one run per event, with the event's fields as inputs.",
    "",
    "| Trigger | Title | Watch node | Description | Event fields |",
    "|---------|-------|------------|-------------|--------------|",
    ...rows,
    "",
  ];
}
