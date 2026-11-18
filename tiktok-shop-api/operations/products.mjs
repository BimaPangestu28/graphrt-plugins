/**
 * Shop and product operations: authorized shops, product search and details, inventory and price updates.
 * Inventory and price updates are POST writes: the shared client never retries them after an unknown outcome. They
 * are node only (never agent tools): a person decides in a workflow when prices and inventory change.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { rejectInput, toPageTokenPage } from "../lib/client.mjs";
import { optionalUnixSeconds, requireNumericId, requireOrderedRange } from "../lib/validation.mjs";

const PRODUCT_STATUSES = ["ALL", "DRAFT", "PENDING", "FAILED", "ACTIVATE", "SELLER_DEACTIVATED", "PLATFORM_DEACTIVATED", "FREEZE", "DELETED"];
const MAX_PRODUCTS_PER_PAGE = 100;
const MAX_SKUS_PER_UPDATE = 100;
const MAX_INVENTORY_QUANTITY = 999999;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
// Currencies without a minor unit: TikTok Shop prices in them must be whole numbers.
const ZERO_DECIMAL_CURRENCIES = new Set(["IDR", "JPY", "KRW", "VND"]);
const PRODUCT_ID_PROPERTY = { type: "string", minLength: 1, description: "TikTok Shop product id" };
const UNKNOWN_OUTCOME_HINT = "If this fails with a network error the update may still have been applied: check with get_product before retrying.";

export const productOperations = [
  {
    name: "get_authorized_shops",
    title: "Get TikTok Shop authorized shops",
    description: "List the shops that authorized this app, with each shop's cipher (set TIKTOK_SHOP_CIPHER to it), region and seller type.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => {
      const body = await client.shop.request({ path: "/authorization/202309/shops", includeShopCipher: false, signal });
      return { data: body?.data?.shops ?? [] };
    },
  },
  {
    name: "search_products",
    title: "Search TikTok Shop products",
    description: "List the shop's products (id, title, status, SKUs) filtered by status, seller SKU or create/update time (Unix seconds).",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: PRODUCT_STATUSES, default: "ALL" },
        seller_skus: { type: "array", items: { type: "string" }, description: "Only products with these seller SKUs" },
        create_time_ge: { type: "integer", description: "Created at or after (Unix seconds)" },
        create_time_le: { type: "integer", description: "Created at or before (Unix seconds)" },
        update_time_ge: { type: "integer", description: "Updated at or after (Unix seconds)" },
        update_time_le: { type: "integer", description: "Updated at or before (Unix seconds)" },
        limit: { type: "integer", minimum: 1, maximum: MAX_PRODUCTS_PER_PAGE, default: 20, description: "Page size (max 100)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
    },
    run: searchProducts,
  },
  {
    name: "get_product",
    title: "Get a TikTok Shop product",
    description: "Read one product with its SKUs, prices, inventory per warehouse, images and audit status.",
    parameters: { type: "object", properties: { product_id: PRODUCT_ID_PROPERTY, locale: { type: "string", description: "e.g. id-ID or en-US" } }, required: ["product_id"] },
    run: async ({ client, args, signal }) => {
      const path = `/product/202309/products/${pathSegment(requireNumericId("product_id", args.product_id))}`;
      const body = await client.shop.request({ path, query: { locale: args.locale }, signal });
      return { data: body?.data ?? null };
    },
  },
  {
    name: "update_inventory",
    nodeOnly: true,
    title: "Update TikTok Shop inventory",
    description: `Set the in-stock quantity of SKUs of one product, per warehouse (warehouse_id is optional when the shop has one warehouse). ${UNKNOWN_OUTCOME_HINT}`,
    parameters: {
      type: "object",
      properties: {
        product_id: PRODUCT_ID_PROPERTY,
        skus: {
          type: "array",
          items: { type: "object" },
          maxItems: MAX_SKUS_PER_UPDATE,
          description: 'Entries {sku_id, quantity, warehouse_id?}, e.g. [{"sku_id": "1729592969712207013", "quantity": 25}]',
        },
      },
      required: ["product_id", "skus"],
    },
    run: async ({ client, args, signal }) => {
      const path = `/product/202309/products/${pathSegment(requireNumericId("product_id", args.product_id))}/inventory/update`;
      const body = await client.shop.request({ method: "POST", path, json: { skus: buildInventorySkus(args.skus) }, signal });
      return { data: body?.data ?? {} };
    },
  },
  {
    name: "update_price",
    nodeOnly: true,
    title: "Update TikTok Shop price",
    description: `Set the price of SKUs of one ACTIVATE product that is not in a promotion. ${UNKNOWN_OUTCOME_HINT}`,
    parameters: {
      type: "object",
      properties: {
        product_id: PRODUCT_ID_PROPERTY,
        currency: { type: "string", minLength: 3, maxLength: 3, description: "ISO 4217 currency code of the shop's market in capitals, e.g. IDR" },
        skus: { type: "array", items: { type: "object" }, maxItems: MAX_SKUS_PER_UPDATE, description: 'Entries {sku_id, amount}, e.g. [{"sku_id": "1729592969712207013", "amount": "150000"}]' },
      },
      required: ["product_id", "currency", "skus"],
    },
    run: async ({ client, args, signal }) => {
      const path = `/product/202309/products/${pathSegment(requireNumericId("product_id", args.product_id))}/prices/update`;
      const body = await client.shop.request({ method: "POST", path, json: { skus: buildPriceSkus(args.skus, args.currency) }, signal });
      return { data: body?.data ?? {} };
    },
  },
];

async function searchProducts({ client, args, signal }) {
  requireOrderedRange({ fromName: "create_time_ge", from: args.create_time_ge, toName: "create_time_le", to: args.create_time_le });
  requireOrderedRange({ fromName: "update_time_ge", from: args.update_time_ge, toName: "update_time_le", to: args.update_time_le });
  const json = {
    status: args.status,
    seller_skus: args.seller_skus,
    create_time_ge: optionalUnixSeconds("create_time_ge", args.create_time_ge),
    create_time_le: optionalUnixSeconds("create_time_le", args.create_time_le),
    update_time_ge: optionalUnixSeconds("update_time_ge", args.update_time_ge),
    update_time_le: optionalUnixSeconds("update_time_le", args.update_time_le),
  };
  const query = { page_size: args.limit, page_token: args.cursor };
  const body = await client.shop.request({ method: "POST", path: "/product/202502/products/search", query, json, signal, idempotent: true });
  return toPageTokenPage(body?.data, "products", args.cursor);
}

/**
 * Converts `[{sku_id, quantity, warehouse_id?}]` into TikTok Shop `skus` with `inventory` grouped per SKU.
 *
 * @param skuEntries - Entries from the arguments (Array<object>)
 * @returns Request `skus` (Array<object>)
 * @throws PluginError kind `invalid_input` - On empty lists, bad ids, quantities outside 0-999,999 or a repeated
 *   (sku_id, warehouse_id) pair
 */
export function buildInventorySkus(skuEntries) {
  if (skuEntries.length === 0) rejectInput("`skus` needs at least one entry");
  const inventoryBySku = new Map();
  const seenSkuWarehouses = new Set();
  skuEntries.forEach((skuEntry, index) => {
    const skuId = requireNumericId(`skus[${index}].sku_id`, skuEntry.sku_id);
    const quantity = Number(skuEntry.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_INVENTORY_QUANTITY) {
      rejectInput(`\`skus[${index}].quantity\` must be a whole number from 0 to ${MAX_INVENTORY_QUANTITY}`);
    }
    const warehouseId = skuEntry.warehouse_id === undefined ? undefined : requireNumericId(`skus[${index}].warehouse_id`, skuEntry.warehouse_id);
    rejectRepeatedSkuWarehouse(seenSkuWarehouses, skuId, warehouseId);
    const inventory = warehouseId ? { warehouse_id: warehouseId, quantity } : { quantity };
    inventoryBySku.set(skuId, [...(inventoryBySku.get(skuId) ?? []), inventory]);
  });
  return [...inventoryBySku].map(([skuId, inventory]) => ({ id: skuId, inventory }));
}

function rejectRepeatedSkuWarehouse(seenSkuWarehouses, skuId, warehouseId) {
  const skuWarehouseKey = JSON.stringify([skuId, warehouseId ?? null]);
  if (seenSkuWarehouses.has(skuWarehouseKey)) {
    rejectInput(`\`skus\` repeats sku_id ${skuId}${warehouseId ? ` in warehouse ${warehouseId}` : ""}; send each SKU/warehouse once`);
  }
  seenSkuWarehouses.add(skuWarehouseKey);
}

/**
 * Converts `[{sku_id, amount}]` into TikTok Shop `skus` with `price: {amount, currency}`.
 *
 * @param skuEntries - Entries from the arguments (Array<object>)
 * @param currency - Three-letter uppercase currency code, e.g. "IDR" (string)
 * @returns Request `skus` (Array<object>)
 * @throws PluginError kind `invalid_input` - On empty lists, duplicate SKUs, bad ids, a malformed currency,
 *   non-positive amounts or fractional amounts in a zero-decimal currency (IDR, JPY, KRW, VND)
 *
 * @example
 * buildPriceSkus([{ sku_id: "1", amount: "150000" }], "IDR"); // [{ id: "1", price: { amount: "150000", currency: "IDR" } }]
 */
export function buildPriceSkus(skuEntries, currency) {
  if (!CURRENCY_CODE_PATTERN.test(currency)) rejectInput(`\`currency\` must be a three-letter uppercase code such as IDR, got ${JSON.stringify(currency)}`);
  if (skuEntries.length === 0) rejectInput("`skus` needs at least one entry");
  const seenSkuIds = new Set();
  return skuEntries.map((skuEntry, index) => {
    const skuId = requireNumericId(`skus[${index}].sku_id`, skuEntry.sku_id);
    if (seenSkuIds.has(skuId)) rejectInput(`\`skus\` repeats sku_id ${skuId}`);
    seenSkuIds.add(skuId);
    return { id: skuId, price: { amount: readPriceAmount(skuEntry.amount, currency, index), currency } };
  });
}

function readPriceAmount(rawAmount, currency, index) {
  const amount = String(rawAmount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) rejectInput(`\`skus[${index}].amount\` must be a positive decimal number`);
  if (ZERO_DECIMAL_CURRENCIES.has(currency) && amount.includes(".")) {
    rejectInput(`\`skus[${index}].amount\` must be a whole number: ${currency} has no decimal places, got ${amount}`);
  }
  return amount;
}
