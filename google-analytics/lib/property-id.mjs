/**
 * GA4 property ids. The API paths take the bare number (`/properties/{property_id}`), while list_account_summaries
 * and the Admin API name properties `properties/123456789`. Both forms are accepted and reduced to the digits;
 * anything else (measurement ids like G-ABC123, extra path segments) is refused before any request.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const PROPERTY_ID_PATTERN = /^(?:properties\/)?(\d{1,20})$/;

/**
 * Reduces a property id to its digits.
 *
 * @param propertyId - e.g. "123456789" or "properties/123456789" (string | number)
 * @returns The digits (string)
 * @throws PluginError kind `invalid_input` - Not a GA4 property id
 *
 * @example
 * normalizePropertyId("properties/123456789"); // "123456789"
 */
export function normalizePropertyId(propertyId) {
  const match = PROPERTY_ID_PATTERN.exec(String(propertyId ?? "").trim());
  if (!match) {
    throw new PluginError(`\`property_id\` must be a numeric GA4 property id like 123456789 or properties/123456789 (not a G-... measurement id); got ${JSON.stringify(String(propertyId).slice(0, 60))}`, { kind: "invalid_input" });
  }
  return match[1];
}

/**
 * Wraps an operation with a `property_id` param so it accepts both id forms.
 *
 * @param operation - Operation (object)
 * @returns The operation, with `property_id` normalized before it runs (object)
 */
export function wrapPropertyIdOperation(operation) {
  if (!operation.parameters?.properties?.property_id) return operation;
  const propertyIdSchema = operation.parameters.properties.property_id;
  return {
    ...operation,
    parameters: {
      ...operation.parameters,
      properties: { ...operation.parameters.properties, property_id: { ...propertyIdSchema, description: "GA4 property id: 123456789 or properties/123456789 (from list_account_summaries)" } },
    },
    run: (context) => operation.run({ ...context, args: { ...context.args, property_id: normalizePropertyId(context.args.property_id) } }),
  };
}
