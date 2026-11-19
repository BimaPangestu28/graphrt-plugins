/**
 * JSON-encoded query arguments. Some ads APIs (Meta Marketing API `effective_status`, TikTok `fields`,
 * `dimensions`, `advertiser_ids`) take a list as a JSON array in one query value: `fields=["a","b"]`. The declarative
 * layer sends a list of strings as `a,b`, so those params are declared as strings in the spec, and this wrapper
 * shows them to callers as lists and encodes each list as JSON text before the request is built.
 *
 * This file is identical in meta-ads and tiktok-ads; keep it so.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Returns the definition with `paramNames` accepted as lists and sent as JSON arrays.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param paramNames - Params that hold a JSON list; only operations that declare them `type: "string"` are wrapped,
 *   so a body param of the same name declared as an array is sent as a real array (string[])
 * @returns A new definition; restSpec is unchanged (object)
 *
 * @example
 * encodeListArgsAsJson(definition, ["fields"]); // {fields: ["a", "b"]} is sent as fields=["a","b"]
 */
export function encodeListArgsAsJson(pluginDefinition, paramNames) {
  const listParams = new Set(paramNames);
  const wrapOperation = (operation) => {
    const properties = operation.parameters?.properties ?? {};
    const wrappedNames = Object.keys(properties).filter((paramName) => listParams.has(paramName) && properties[paramName].type === "string");
    if (wrappedNames.length === 0) return operation;
    return {
      ...operation,
      parameters: relaxListSchemas(operation.parameters, wrappedNames),
      run: (context) => operation.run({ ...context, args: encodeListArgs(context.args ?? {}, wrappedNames) }),
    };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Encodes the listed arguments as JSON array text.
 *
 * @param args - Validated arguments (object)
 * @param paramNames - Arguments to encode (string[])
 * @returns A copy with each present list as JSON text (object)
 * @throws PluginError kind `invalid_input` - An item is not a non-empty string or a number
 *
 * @example
 * encodeListArgs({ fields: ["spend", "impressions"] }, ["fields"]); // { fields: '["spend","impressions"]' }
 */
export function encodeListArgs(args, paramNames) {
  const encodedArgs = { ...args };
  for (const paramName of paramNames) {
    const listValue = args[paramName];
    if (listValue === undefined) continue;
    encodedArgs[paramName] = JSON.stringify(listValue.map((item, index) => checkListItem(paramName, item, index)));
  }
  return encodedArgs;
}

function checkListItem(paramName, item, index) {
  if (typeof item === "number" && Number.isFinite(item)) return String(item);
  if (typeof item === "string" && item.trim() !== "") return item.trim();
  throw new PluginError(`\`${paramName}[${index}]\` must be a non-empty string`, { kind: "invalid_input" });
}

function relaxListSchemas(parameters, paramNames) {
  const properties = { ...parameters.properties };
  for (const paramName of paramNames) {
    const listSchema = { ...properties[paramName], type: "array", items: { type: "string" } };
    delete listSchema.minLength;
    properties[paramName] = listSchema;
  }
  return { ...parameters, properties };
}
