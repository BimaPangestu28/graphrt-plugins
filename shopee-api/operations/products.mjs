/**
 * Shop and product operations: shop info, item list and details, stock and price updates.
 * Stock and price updates are POST writes: the shared client never retries them after an unknown outcome. They are
 * node only (never agent tools): a person decides in a workflow when prices and stock change.
 */
import { extractShopeeResponse, rejectInput } from "../lib/client.mjs";
import { joinIdList, requireIntegerId, requireUnixSeconds } from "../lib/validation.mjs";

const ITEM_STATUSES = ["NORMAL", "BANNED", "UNLIST", "REVIEWING", "SELLER_DELETE", "SHOPEE_DELETE"];
const MAX_ITEMS_PER_PAGE = 100;
const MAX_ITEM_IDS = 50;
const MAX_MODELS_PER_UPDATE = 50;
const OFFSET_CURSOR_PATTERN = /^\d+$/;
const UNKNOWN_OUTCOME_HINT = "If this failed with a network error the update may still have been applied: check with get_item_base_info before retrying.";

export const productOperations = [
  {
    name: "get_shop_info",
    title: "Get Shopee shop info",
    description: "Read the authorized Shopee shop: name, region, status, authorization expiry and cross-border flags.",
    parameters: { type: "object", properties: {} },
    run: async ({ client, signal }) => ({ data: extractShopeeResponse(await client.shop.request({ path: "/api/v2/shop/get_shop_info", signal })) }),
  },
  {
    name: "get_item_list",
    title: "List Shopee items",
    description: "List the shop's item ids with status and update time (offset paging). Use get_item_base_info for details.",
    parameters: {
      type: "object",
      properties: {
        item_status: { type: "array", items: { type: "string", enum: ITEM_STATUSES }, default: ["NORMAL"], description: "Statuses to include" },
        update_time_from: { type: "integer", description: "Only items updated at or after this Unix time (seconds)" },
        update_time_to: { type: "integer", description: "Only items updated at or before this Unix time (seconds)" },
        limit: { type: "integer", minimum: 1, maximum: MAX_ITEMS_PER_PAGE, default: 50, description: "Page size (max 100)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
    },
    run: listItems,
  },
  {
    name: "get_item_base_info",
    title: "Get Shopee item details",
    description: "Read base info (name, status, price info, stock info, images) for up to 50 items.",
    parameters: {
      type: "object",
      properties: { item_ids: { type: "array", items: { type: "integer" }, maxItems: MAX_ITEM_IDS, description: "1-50 item ids" } },
      required: ["item_ids"],
    },
    run: async ({ client, args, signal }) => {
      const query = { item_id_list: joinIdList("item_ids", args.item_ids, MAX_ITEM_IDS) };
      const body = await client.shop.request({ path: "/api/v2/product/get_item_base_info", query, signal });
      return { data: extractShopeeResponse(body)?.item_list ?? [] };
    },
  },
  {
    name: "update_stock",
    nodeOnly: true,
    title: "Update Shopee stock",
    description: `Set seller stock for an item or its models (variations). Check failure_list in the result for models Shopee rejected. ${UNKNOWN_OUTCOME_HINT}`,
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "Item id" },
        stock_list: {
          type: "array",
          items: { type: "object" },
          maxItems: MAX_MODELS_PER_UPDATE,
          description: 'Entries {model_id (0 or omitted for items without models), stock, location_id (only for multi-warehouse shops)}, e.g. [{"model_id": 0, "stock": 25}]',
        },
      },
      required: ["item_id", "stock_list"],
    },
    run: async ({ client, args, signal }) => {
      const json = { item_id: requireIntegerId("item_id", args.item_id), stock_list: buildSellerStockList(args.stock_list) };
      return { data: extractShopeeResponse(await client.shop.request({ method: "POST", path: "/api/v2/product/update_stock", json, signal })) };
    },
  },
  {
    name: "update_price",
    nodeOnly: true,
    title: "Update Shopee price",
    description: `Set the original price of an item or its models (variations). Check failure_list in the result. ${UNKNOWN_OUTCOME_HINT}`,
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "integer", description: "Item id" },
        price_list: {
          type: "array",
          items: { type: "object" },
          maxItems: MAX_MODELS_PER_UPDATE,
          description: 'Entries {model_id (0 or omitted for items without models), original_price}, e.g. [{"model_id": 0, "original_price": 150000}]',
        },
      },
      required: ["item_id", "price_list"],
    },
    run: async ({ client, args, signal }) => {
      const json = { item_id: requireIntegerId("item_id", args.item_id), price_list: buildPriceList(args.price_list) };
      return { data: extractShopeeResponse(await client.shop.request({ method: "POST", path: "/api/v2/product/update_price", json, signal })) };
    },
  },
];

async function listItems({ client, args, signal }) {
  if (args.item_status.length === 0) rejectInput("`item_status` needs at least one status");
  const query = { offset: parseOffsetCursor(args.cursor), page_size: args.limit, ...readUpdateTimeWindow(args) };
  // Shopee wants repeated item_status parameters (item_status=NORMAL&item_status=UNLIST), not a comma list.
  const body = await client.shop.request({ path: "/api/v2/product/get_item_list", query, repeatedQuery: { item_status: args.item_status }, signal });
  const payload = extractShopeeResponse(body);
  return { data: payload?.item ?? [], next_cursor: payload?.has_next_page ? String(payload.next_offset) : null };
}

function readUpdateTimeWindow({ update_time_from: updateTimeFrom, update_time_to: updateTimeTo }) {
  if (updateTimeFrom !== undefined) requireUnixSeconds("update_time_from", updateTimeFrom);
  if (updateTimeTo !== undefined) requireUnixSeconds("update_time_to", updateTimeTo);
  if (updateTimeFrom !== undefined && updateTimeTo !== undefined && updateTimeFrom > updateTimeTo) {
    rejectInput("`update_time_from` must be at or before `update_time_to`");
  }
  return { update_time_from: updateTimeFrom, update_time_to: updateTimeTo };
}

function parseOffsetCursor(cursor) {
  if (cursor === undefined) return 0;
  if (!OFFSET_CURSOR_PATTERN.test(cursor)) rejectInput("`cursor` must be the numeric next_cursor returned by get_item_list");
  return Number(cursor);
}

/**
 * Converts `[{model_id, stock, location_id}]` into Shopee's `stock_list` with `seller_stock` grouped per model.
 *
 * @param stockEntries - Entries from the arguments (Array<object>)
 * @returns Shopee stock_list (Array<object>)
 * @throws PluginError kind `invalid_input` - On empty lists, bad ids, negative/non-integer stock or a repeated
 *   (model_id, location_id) pair (Shopee would apply only one of them)
 */
export function buildSellerStockList(stockEntries) {
  if (stockEntries.length === 0) rejectInput("`stock_list` needs at least one entry");
  const sellerStockByModel = new Map();
  const seenModelLocations = new Set();
  stockEntries.forEach((stockEntry, index) => {
    const modelId = requireIntegerId(`stock_list[${index}].model_id`, stockEntry.model_id ?? 0);
    rejectRepeatedModelLocation(seenModelLocations, modelId, stockEntry.location_id);
    const stock = Number(stockEntry.stock);
    if (!Number.isInteger(stock) || stock < 0) rejectInput(`\`stock_list[${index}].stock\` must be a whole number >= 0`);
    const sellerStock = stockEntry.location_id ? { location_id: String(stockEntry.location_id), stock } : { stock };
    sellerStockByModel.set(modelId, [...(sellerStockByModel.get(modelId) ?? []), sellerStock]);
  });
  return [...sellerStockByModel].map(([modelId, sellerStock]) => ({ model_id: modelId, seller_stock: sellerStock }));
}

function rejectRepeatedModelLocation(seenModelLocations, modelId, locationId) {
  const modelLocationKey = JSON.stringify([modelId, locationId ? String(locationId) : null]);
  if (seenModelLocations.has(modelLocationKey)) {
    rejectInput(`\`stock_list\` repeats model_id ${modelId}${locationId ? ` at location ${locationId}` : ""}; send each model/location once`);
  }
  seenModelLocations.add(modelLocationKey);
}

/**
 * Converts `[{model_id, original_price}]` into Shopee's `price_list`.
 *
 * @param priceEntries - Entries from the arguments (Array<object>)
 * @returns Shopee price_list (Array<object>)
 * @throws PluginError kind `invalid_input` - On empty lists, duplicate models, bad ids or non-positive prices
 */
export function buildPriceList(priceEntries) {
  if (priceEntries.length === 0) rejectInput("`price_list` needs at least one entry");
  const seenModelIds = new Set();
  return priceEntries.map((priceEntry, index) => {
    const modelId = requireIntegerId(`price_list[${index}].model_id`, priceEntry.model_id ?? 0);
    if (seenModelIds.has(modelId)) rejectInput(`\`price_list\` repeats model_id ${modelId}`);
    seenModelIds.add(modelId);
    const originalPrice = Number(priceEntry.original_price);
    if (!Number.isFinite(originalPrice) || originalPrice <= 0) rejectInput(`\`price_list[${index}].original_price\` must be a number > 0`);
    return { model_id: modelId, original_price: originalPrice };
  });
}
