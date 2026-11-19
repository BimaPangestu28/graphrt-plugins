/**
 * Node keys graphrt keeps for itself. When graphrt loads a workflow it removes these keys from every node before
 * the rest becomes the plugin's config (graphrt-core `NodeDoc::from_raw` / `extract_policy` in dsl.rs), so a plugin
 * parameter with one of these names can never be set from a node — only from a tool call. `data` is also taken:
 * an object `data` is flattened into the node, anything else is dropped.
 *
 * Plugins rename such parameters (e.g. `title` → `sheet_title`) and keep the API field name: `wireName` in a
 * declarative spec, an explicit mapping in a hand-written `run`.
 */

/** Keys graphrt-core removes from a node, in dsl.rs order (identity, layout wrapper, policy, editor-only keys). */
export const RESERVED_NODE_KEYS = Object.freeze([
  "id",
  "parentId",
  "parent",
  "data",
  "container_id",
  "iteration_id",
  "loop_id",
  "type",
  "title",
  "on_error",
  "error_strategy",
  "default_value",
  "retry",
  "retry_config",
  "timeout_ms",
  "timeout",
  "desc",
  "selected",
  "position",
  "positionAbsolute",
  "width",
  "height",
  "sourcePosition",
  "targetPosition",
  "zIndex",
  "isInIteration",
  "isInLoop",
]);
const RESERVED_KEY_SET = new Set(RESERVED_NODE_KEYS);

/**
 * Whether graphrt takes this key from a workflow node, so a parameter of that name never reaches the plugin.
 *
 * @param parameterName - Parameter name (string)
 * @returns True when the name is reserved (boolean)
 *
 * @example
 * isReservedNodeKey("title"); // true
 * isReservedNodeKey("sheet_title"); // false
 */
export function isReservedNodeKey(parameterName) {
  return RESERVED_KEY_SET.has(parameterName);
}

/**
 * Throws when any operation of a plugin definition has a parameter graphrt reserves on nodes.
 *
 * @param pluginDefinition - Plugin definition with `name` and `operations[].parameters.properties` (object)
 * @returns Nothing
 * @throws Error - "<plugin>: operation `<op>`: parameter `<name>` is reserved by graphrt ..." for the first one found
 *
 * @example
 * assertNoReservedParameters({ name: "x", operations: [{ name: "add", parameters: { properties: { title: {} } } }] });
 * // throws: x: operation `add`: parameter `title` is reserved by graphrt ...
 */
export function assertNoReservedParameters(pluginDefinition) {
  for (const operation of pluginDefinition.operations ?? []) {
    const reservedName = Object.keys(operation.parameters?.properties ?? {}).find(isReservedNodeKey);
    if (reservedName === undefined) continue;
    throw new Error(
      `${pluginDefinition.name}: operation \`${operation.name}\`: parameter \`${reservedName}\` is reserved by graphrt on workflow nodes, ` +
        `so a node could never set it; rename it (e.g. \`${operation.name.split("_").at(-1)}_${reservedName}\`) and map it to the API field in run()`,
    );
  }
}

/**
 * The load-time message for a declarative param with a reserved name, suggesting `wireName`.
 *
 * @param parameterName - The reserved param name (string)
 * @returns Problem text for the spec validator (string)
 */
export function describeReservedParam(parameterName) {
  return (
    `\`${parameterName}\` is reserved by graphrt on workflow nodes, so a node could never set it; ` +
    `rename it to something descriptive (e.g. \`item_${parameterName}\`) and keep the API field name with \`wireName: "${parameterName}"\``
  );
}
