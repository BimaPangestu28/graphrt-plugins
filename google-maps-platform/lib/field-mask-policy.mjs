/**
 * Places API (New) bills a call at the SKU of the most expensive field in its X-Goog-FieldMask: `*`, ratings,
 * phone numbers, opening hours or reviews move every call to Enterprise (+ Atmosphere) pricing. Agent tool calls
 * of search_text, search_nearby and get_place may therefore only ask for Essentials and Pro fields, unless
 * GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS=1. Workflow nodes are unaffected.
 *
 * Fields are checked by their top-level name (`displayName.text` counts as `displayName`); search masks name them
 * under `places.` and may add `nextPageToken`. Photos are left out: photo media are billed separately and agents
 * get them through get_place_photo only when the opt-in is set.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const EXPENSIVE_FIELDS_ENV = "GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS";

// Place Details / Text Search Essentials and Pro fields (developers.google.com/maps/documentation/places/web-service/data-fields).
export const AGENT_PLACE_FIELDS = Object.freeze([
  "id", "name", "attributions", "addressComponents", "adrFormatAddress", "formattedAddress", "shortFormattedAddress", "postalAddress",
  "location", "viewport", "plusCode", "types", "primaryType", "primaryTypeDisplayName", "displayName", "businessStatus",
  "googleMapsUri", "googleMapsLinks", "utcOffsetMinutes", "iconBackgroundColor", "iconMaskBaseUri", "accessibilityOptions",
  "containingPlaces", "pureServiceAreaBusiness", "subDestinations",
]);
const SEARCH_EXTRA_FIELDS = new Set(["nextPageToken"]);

function findExpensiveField(fieldMask, isSearch) {
  const fields = String(fieldMask ?? "").split(",").map((field) => field.trim()).filter(Boolean);
  return fields.find((field) => {
    if (isSearch && SEARCH_EXTRA_FIELDS.has(field)) return false;
    const placeField = isSearch ? (field.startsWith("places.") ? field.slice("places.".length) : null) : field;
    const topLevelField = placeField?.split(".")[0];
    return !topLevelField || !AGENT_PLACE_FIELDS.includes(topLevelField);
  });
}

/**
 * Returns the definition with tool calls of the given Places operations limited to Essentials/Pro fields.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param policy - `{searchOperations: string[], detailOperations: string[]}`: masks under `places.` or plain (object)
 * @returns A new definition (object)
 */
export function limitToolFieldMasks(pluginDefinition, { searchOperations, detailOperations }) {
  const wrapOperation = (operation) => {
    const isSearch = searchOperations.includes(operation.name);
    if (!isSearch && !detailOperations.includes(operation.name)) return operation;
    const run = (context) => {
      if (context.source === "tool" && context.environment?.[EXPENSIVE_FIELDS_ENV] !== "1") assertAffordableMask(operation.name, context.args.field_mask, isSearch);
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

function assertAffordableMask(operationName, fieldMask, isSearch) {
  const expensiveField = findExpensiveField(fieldMask, isSearch);
  if (expensiveField === undefined) return;
  throw new PluginError(
    `\`${operationName}\` as an agent tool may only request Essentials/Pro fields (${isSearch ? "places." : ""}${AGENT_PLACE_FIELDS.join(", ")}); "${expensiveField}" is billed at a higher SKU. Set ${EXPENSIVE_FIELDS_ENV}=1 to allow it, or use a workflow node`,
    { kind: "permission_denied" },
  );
}
