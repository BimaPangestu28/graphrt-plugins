/**
 * XML `payload` documents for Lazada product updates (/product/price_quantity/update,
 * /product/stock/sellable/update): `<Request><Product><Skus><Sku>...</Sku></Skus></Product></Request>`.
 * Values are escaped; only the listed fields are written, so a caller cannot inject other elements.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const MAX_SKUS_PER_UPDATE = 50;

/**
 * Escapes text for an XML element.
 *
 * @param value - Text (string | number)
 * @returns Escaped text (string)
 *
 * @example
 * escapeXml("A&B <1>"); // "A&amp;B &lt;1&gt;"
 */
export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => XML_ESCAPES[character]);
}

/**
 * Builds the payload for a list of SKUs.
 *
 * @param skus - Items from the caller, e.g. [{item_id, sku_id, quantity}] (object[])
 * @param fieldMap - `[[argumentName, ElementName], ...]` written in this order when present (Array)
 * @param requiredOneOf - Argument names of which each SKU needs at least one, e.g. ["price", "quantity"] (string[])
 * @returns XML document (string)
 * @throws PluginError kind `invalid_input` - Empty list, too many SKUs, a SKU without an id or a value
 */
export function buildSkuPayload(skus, fieldMap, requiredOneOf) {
  if (!Array.isArray(skus) || skus.length === 0) throw new PluginError("`skus` needs at least one SKU", { kind: "invalid_input" });
  if (skus.length > MAX_SKUS_PER_UPDATE) throw new PluginError(`\`skus\` takes at most ${MAX_SKUS_PER_UPDATE} SKUs per call`, { kind: "invalid_input" });
  const skuElements = skus.map((sku, index) => buildSkuElement(sku, index, fieldMap, requiredOneOf)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Request><Product><Skus>${skuElements}</Skus></Product></Request>`;
}

function buildSkuElement(sku, index, fieldMap, requiredOneOf) {
  if (!sku || typeof sku !== "object") throw new PluginError(`skus[${index}] must be an object`, { kind: "invalid_input" });
  const hasId = (sku.item_id !== undefined && sku.sku_id !== undefined) || sku.seller_sku !== undefined;
  if (!hasId) throw new PluginError(`skus[${index}] needs item_id and sku_id, or seller_sku`, { kind: "invalid_input" });
  if (!requiredOneOf.some((argumentName) => sku[argumentName] !== undefined)) {
    throw new PluginError(`skus[${index}] needs one of ${requiredOneOf.join(", ")}`, { kind: "invalid_input" });
  }
  const elements = fieldMap
    .filter(([argumentName]) => sku[argumentName] !== undefined && sku[argumentName] !== null)
    .map(([argumentName, elementName]) => `<${elementName}>${escapeXml(sku[argumentName])}</${elementName}>`);
  return `<Sku>${elements.join("")}</Sku>`;
}
