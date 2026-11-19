/**
 * Read operations: seller, products, orders and order items. All are GET requests (retried after 5xx and network
 * failures) and agent tools. Lists use offset paging: pass `next_cursor` back as `cursor`.
 */
import { extractLazadaData } from "../lib/client.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";

const PRODUCT_FILTERS = ["all", "live", "inactive", "deleted", "image-missing", "pending", "rejected", "sold-out"];
const ORDER_STATUSES = ["unpaid", "pending", "packed", "ready_to_ship", "shipped", "delivered", "canceled", "returned", "failed", "topack", "toship", "confirmed", "lost_by_3pl", "damaged_by_3pl"];
const MAX_PRODUCTS_PER_PAGE = 50;
const MAX_ORDERS_PER_PAGE = 100;
const MAX_ORDER_IDS = 50;
const cursorProperty = { type: "string", description: "next_cursor from the previous call" };
const isoTime = (description) => ({ type: "string", description: `${description} (ISO 8601, e.g. 2026-11-01T00:00:00+07:00)` });

function readOffset(cursor) {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(String(cursor))) throw new PluginError("`cursor` must be a next_cursor from a previous call", { kind: "invalid_input" });
  return Number(cursor);
}

/**
 * Computes the next offset cursor.
 *
 * @param offset - Offset of this page (number)
 * @param pageLength - Items returned (number)
 * @param limit - Page size asked for (number)
 * @param total - Total items when Lazada reports it (number, optional)
 * @returns Next cursor or null (string | null)
 */
export function nextOffsetCursor(offset, pageLength, limit, total) {
  const nextOffset = offset + pageLength;
  if (pageLength < limit) return null;
  if (Number.isFinite(total) && nextOffset >= total) return null;
  return String(nextOffset);
}

async function listProducts({ client, args, signal }) {
  const offset = readOffset(args.cursor);
  const query = {
    filter: args.filter,
    offset,
    limit: args.limit,
    create_after: args.create_after,
    update_after: args.update_after,
    sku_seller_list: args.seller_skus,
  };
  const data = extractLazadaData(await client.request({ path: "/products/get", query, signal }));
  const products = data?.products ?? [];
  return { data: products, next_cursor: nextOffsetCursor(offset, products.length, args.limit, Number(data?.total_products)) };
}

async function listOrders({ client, args, signal }) {
  if (!args.created_after && !args.update_after) throw new PluginError("list_orders needs created_after or update_after", { kind: "invalid_input" });
  const offset = readOffset(args.cursor);
  const query = {
    created_after: args.created_after,
    created_before: args.created_before,
    update_after: args.update_after,
    update_before: args.update_before,
    status: args.status,
    sort_by: args.sort_by,
    sort_direction: args.sort_direction,
    offset,
    limit: args.limit,
  };
  const data = extractLazadaData(await client.request({ path: "/orders/get", query, signal }));
  const orders = data?.orders ?? [];
  return { data: orders, next_cursor: nextOffsetCursor(offset, orders.length, args.limit, Number(data?.countTotal)) };
}

const readData = (path, buildQuery) => async ({ client, args, signal }) => ({ data: extractLazadaData(await client.request({ path, query: buildQuery(args), signal })) });

export const readOperations = [
  {
    name: "get_seller",
    title: "Get Lazada seller",
    description: "The authorized seller: name, email, location, verification status; a cheap way to check the token",
    parameters: { type: "object", properties: {} },
    run: readData("/seller/get", () => ({})),
  },
  {
    name: "list_products",
    title: "List Lazada products",
    description: "List products with their SKUs (price, stock, status)",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", enum: PRODUCT_FILTERS, default: "all" },
        create_after: isoTime("Created after"),
        update_after: isoTime("Updated after"),
        seller_skus: { type: "array", items: { type: "string" }, maxItems: 100, description: "Only these seller SKUs (sent as sku_seller_list)" },
        limit: { type: "integer", minimum: 1, maximum: MAX_PRODUCTS_PER_PAGE, default: 20 },
        cursor: cursorProperty,
      },
    },
    run: listProducts,
  },
  {
    name: "get_product",
    title: "Get Lazada product",
    description: "Retrieve one product by item_id or seller_sku",
    parameters: { type: "object", properties: { item_id: { type: "integer", minimum: 1 }, seller_sku: { type: "string", minLength: 1 } } },
    run: async (context) => {
      if (context.args.item_id === undefined && !context.args.seller_sku) throw new PluginError("get_product needs item_id or seller_sku", { kind: "invalid_input" });
      return readData("/product/item/get", (args) => ({ item_id: args.item_id, seller_sku: args.seller_sku }))(context);
    },
  },
  {
    name: "list_orders",
    title: "List Lazada orders",
    description: "List orders created or updated after a time, optionally by status",
    parameters: {
      type: "object",
      properties: {
        created_after: isoTime("Created after (this or update_after is required)"),
        created_before: isoTime("Created before"),
        update_after: isoTime("Updated after"),
        update_before: isoTime("Updated before"),
        status: { type: "string", enum: ORDER_STATUSES },
        sort_by: { type: "string", enum: ["created_at", "updated_at"], default: "created_at" },
        sort_direction: { type: "string", enum: ["ASC", "DESC"], default: "DESC" },
        limit: { type: "integer", minimum: 1, maximum: MAX_ORDERS_PER_PAGE, default: 50 },
        cursor: cursorProperty,
      },
    },
    run: listOrders,
  },
  {
    name: "get_order",
    title: "Get Lazada order",
    description: "Retrieve one order (buyer, address, totals, statuses)",
    parameters: { type: "object", properties: { order_id: { type: "integer", minimum: 1 } }, required: ["order_id"] },
    run: readData("/order/get", (args) => ({ order_id: args.order_id })),
  },
  {
    name: "get_order_items",
    title: "Get Lazada order items",
    description: "The items of one order (order_item_id, SKU, price, status, package and tracking)",
    parameters: { type: "object", properties: { order_id: { type: "integer", minimum: 1 } }, required: ["order_id"] },
    run: readData("/order/items/get", (args) => ({ order_id: args.order_id })),
  },
  {
    name: "get_multiple_order_items",
    title: "Get items of several Lazada orders",
    description: "The items of up to 50 orders in one call",
    parameters: { type: "object", properties: { order_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: MAX_ORDER_IDS } }, required: ["order_ids"] },
    run: readData("/orders/items/get", (args) => ({ order_ids: args.order_ids })),
  },
];
