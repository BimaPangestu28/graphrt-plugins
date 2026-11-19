/**
 * Shipper's pricing endpoint takes `item_categories` from a fixed list (DomesticPricingRequest in the Shipper
 * OpenAPI spec). The shared argument validator checks the type of array items but not an enum on them, so this
 * wrapper refuses unknown categories before any request and fixes the case of known ones ("pakaian" -> "Pakaian").
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const ITEM_CATEGORIES = Object.freeze([
  "Cairan", "Dokumen", "Elektronik", "Furnitur", "Kosmetik", "Makanan", "Minuman", "Pakaian", "Sepatu", "Spare Parts",
  "Aksesoris", "Dekorasi Rumah", "Mainan", "Obat dan Herbal", "Garmen dan Tekstil", "Buku", "Lainnya",
]);

/**
 * Maps categories to Shipper's spelling.
 *
 * @param categories - Category names (string[])
 * @returns The same categories as listed by Shipper (string[])
 * @throws PluginError kind `invalid_input` - When a category is not in ITEM_CATEGORIES
 */
export function canonicalizeItemCategories(categories) {
  return categories.map((category) => {
    const match = ITEM_CATEGORIES.find((known) => known.toLowerCase() === String(category).trim().toLowerCase());
    if (match) return match;
    throw new PluginError(`item_categories: ${JSON.stringify(category)} is not a Shipper category; use one of ${ITEM_CATEGORIES.join(", ")}`, { kind: "invalid_input" });
  });
}

/**
 * Returns the definition with the operation's item_categories checked against Shipper's list.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationName - Operation with an item_categories argument (string)
 * @returns A new definition (object)
 */
export function checkItemCategories(pluginDefinition, operationName) {
  const wrapOperation = (operation) => {
    if (operation.name !== operationName) return operation;
    const run = (context) => {
      const categories = context.args.item_categories;
      const args = Array.isArray(categories) ? { ...context.args, item_categories: canonicalizeItemCategories(categories) } : context.args;
      return operation.run({ ...context, args });
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
