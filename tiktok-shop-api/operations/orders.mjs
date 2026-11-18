/**
 * Order, fulfilment and return operations. `ship_package` is a POST write and is never retried after an
 * unknown outcome; it is node only (never an agent tool), so shipping happens only where a person put it in a
 * workflow. The searches are POST-only reads, sent with `idempotent: true` so transient failures are retried.
 */
import { pathSegment } from "../lib/shared/path.mjs";
import { toPageTokenPage } from "../lib/client.mjs";
import { optionalUnixSeconds, requireNumericId, requireNumericIds, requireOrderedRange } from "../lib/validation.mjs";

const ORDER_STATUSES = ["UNPAID", "ON_HOLD", "AWAITING_SHIPMENT", "PARTIALLY_SHIPPING", "AWAITING_COLLECTION", "IN_TRANSIT", "DELIVERED", "COMPLETED", "CANCELLED"];
const DOCUMENT_TYPES = ["SHIPPING_LABEL", "PACKING_SLIP", "SHIPPING_LABEL_AND_PACKING_SLIP", "SHIPPING_LABEL_PICTURE", "HAZMAT_LABEL", "INVOICE_LABEL"];
const RETURN_TYPES = ["REFUND", "RETURN_AND_REFUND", "REPLACEMENT", "EXCHANGE"];
const MAX_ORDERS_PER_PAGE = 100;
const MAX_ORDER_IDS = 50;
const MAX_RETURN_FILTER_IDS = 100;
const SORT_PROPERTIES = {
  sort_field: { type: "string", enum: ["create_time", "update_time"], description: "Sort field (default create_time)" },
  sort_order: { type: "string", enum: ["ASC", "DESC"], description: "Sort order" },
};
const TIME_FILTER_PROPERTIES = {
  create_time_ge: { type: "integer", description: "Created at or after (Unix seconds)" },
  create_time_lt: { type: "integer", description: "Created before (Unix seconds)" },
  update_time_ge: { type: "integer", description: "Updated at or after (Unix seconds)" },
  update_time_lt: { type: "integer", description: "Updated before (Unix seconds)" },
};
const PACKAGE_ID_PROPERTY = { type: "string", minLength: 1, description: "Package id (from get_order_detail packages)" };

export const orderOperations = [
  {
    name: "search_orders",
    title: "Search TikTok Shop orders",
    description: "List orders by status, buyer or create/update time window (Unix seconds), newest first by default.",
    parameters: {
      type: "object",
      properties: {
        order_status: { type: "string", enum: ORDER_STATUSES },
        buyer_user_id: { type: "string", description: "Only this buyer's orders" },
        ...TIME_FILTER_PROPERTIES,
        ...SORT_PROPERTIES,
        limit: { type: "integer", minimum: 1, maximum: MAX_ORDERS_PER_PAGE, default: 20, description: "Page size (max 100)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
    },
    run: async ({ client, args, signal }) => {
      const json = { order_status: args.order_status, buyer_user_id: args.buyer_user_id, ...readTimeFilters(args) };
      const query = { page_size: args.limit, page_token: args.cursor, sort_field: args.sort_field, sort_order: args.sort_order };
      const body = await client.shop.request({ method: "POST", path: "/order/202309/orders/search", query, json, signal, idempotent: true });
      return toPageTokenPage(body?.data, "orders", args.cursor);
    },
  },
  {
    name: "get_order_detail",
    title: "Get TikTok Shop order details",
    description: "Read up to 50 orders: status, line items, payment, recipient address and packages (package ids for shipping).",
    parameters: {
      type: "object",
      properties: { order_ids: { type: "array", items: { type: "string" }, maxItems: MAX_ORDER_IDS, description: "1-50 order ids" } },
      required: ["order_ids"],
    },
    run: async ({ client, args, signal }) => {
      const query = { ids: requireNumericIds("order_ids", args.order_ids, MAX_ORDER_IDS) };
      const body = await client.shop.request({ path: "/order/202507/orders", query, signal });
      return { data: body?.data?.orders ?? [] };
    },
  },
  {
    name: "get_package_shipping_document",
    title: "Get TikTok Shop shipping document",
    description: "Get the URL (valid 24 hours) of a TikTok Shipping package's label or packing slip, plus its tracking number. Call ship_package first.",
    parameters: {
      type: "object",
      properties: {
        package_id: PACKAGE_ID_PROPERTY,
        document_type: { type: "string", enum: DOCUMENT_TYPES, default: "SHIPPING_LABEL" },
        document_size: { type: "string", enum: ["A6", "A5"], description: "PDF size (default A6)" },
      },
      required: ["package_id"],
    },
    run: async ({ client, args, signal }) => {
      const path = `/fulfillment/202309/packages/${pathSegment(requireNumericId("package_id", args.package_id))}/shipping_documents`;
      const body = await client.shop.request({ path, query: { document_type: args.document_type, document_size: args.document_size }, signal });
      return { data: body?.data ?? null };
    },
  },
  {
    name: "ship_package",
    nodeOnly: true,
    title: "Ship a TikTok Shop package",
    description:
      "Ship a package: TikTok Shipping (optional handover_method and pickup slot) or seller shipping (self_shipment with tracking_number and shipping_provider_id). " +
      "If this fails with a network error the package may already be shipped: check get_order_detail before retrying.",
    parameters: {
      type: "object",
      properties: {
        package_id: PACKAGE_ID_PROPERTY,
        handover_method: { type: "string", enum: ["PICKUP", "DROP_OFF"] },
        pickup_slot: { type: "object", description: "{start_time, end_time} in Unix seconds" },
        self_shipment: { type: "object", description: "{tracking_number, shipping_provider_id} for SEND_BY_SELLER packages" },
      },
      required: ["package_id"],
    },
    run: async ({ client, args, signal }) => {
      const path = `/fulfillment/202309/packages/${pathSegment(requireNumericId("package_id", args.package_id))}/ship`;
      const json = { handover_method: args.handover_method, pickup_slot: args.pickup_slot, self_shipment: args.self_shipment };
      const body = await client.shop.request({ method: "POST", path, json, signal });
      return { data: body?.data ?? {} };
    },
  },
  {
    name: "search_returns",
    title: "Search TikTok Shop returns",
    description: "List return, refund, replacement and exchange requests by order, return status or time window (Unix seconds).",
    parameters: {
      type: "object",
      properties: {
        order_ids: { type: "array", items: { type: "string" }, maxItems: MAX_RETURN_FILTER_IDS, description: "Only returns of these orders" },
        return_ids: { type: "array", items: { type: "string" }, maxItems: MAX_RETURN_FILTER_IDS, description: "Only these returns" },
        return_status: { type: "array", items: { type: "string" }, description: "e.g. RETURN_OR_REFUND_REQUEST_PENDING, AWAITING_BUYER_SHIP" },
        return_types: { type: "array", items: { type: "string", enum: RETURN_TYPES } },
        ...TIME_FILTER_PROPERTIES,
        ...SORT_PROPERTIES,
        limit: { type: "integer", minimum: 10, maximum: 50, default: 20, description: "Page size (10-50)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
    },
    run: async ({ client, args, signal }) => {
      const json = {
        order_ids: optionalNumericIds("order_ids", args.order_ids),
        return_ids: optionalNumericIds("return_ids", args.return_ids),
        return_status: args.return_status,
        return_types: args.return_types,
        ...readTimeFilters(args),
      };
      const query = { page_size: args.limit, page_token: args.cursor, sort_field: args.sort_field, sort_order: args.sort_order };
      const body = await client.shop.request({ method: "POST", path: "/return_refund/202602/returns/search", query, json, signal, idempotent: true });
      return toPageTokenPage(body?.data, "return_orders", args.cursor);
    },
  },
];

function readTimeFilters(args) {
  requireOrderedRange({ fromName: "create_time_ge", from: args.create_time_ge, toName: "create_time_lt", to: args.create_time_lt });
  requireOrderedRange({ fromName: "update_time_ge", from: args.update_time_ge, toName: "update_time_lt", to: args.update_time_lt });
  return Object.fromEntries(Object.keys(TIME_FILTER_PROPERTIES).map((filterName) => [filterName, optionalUnixSeconds(filterName, args[filterName])]));
}

function optionalNumericIds(argumentName, ids) {
  return ids === undefined || ids.length === 0 ? undefined : requireNumericIds(argumentName, ids, MAX_RETURN_FILTER_IDS);
}
