/**
 * Order and logistics operations: order list and details, shipping parameters, shipping (arrange
 * pickup/drop-off) and tracking numbers. `ship_order` is a POST write and is never retried after an unknown outcome;
 * it is node only (never an agent tool), so shipping happens only where a person put it in a workflow.
 */
import { extractShopeeResponse, rejectInput } from "../lib/client.mjs";
import { joinIdList, validateOrderTimeWindow } from "../lib/validation.mjs";

const ORDER_STATUSES = ["UNPAID", "READY_TO_SHIP", "PROCESSED", "SHIPPED", "COMPLETED", "IN_CANCEL", "CANCELLED", "INVOICE_PENDING"];
const MAX_ORDERS_PER_PAGE = 100;
const MAX_ORDER_SNS = 50;
const DEFAULT_ORDER_DETAIL_FIELDS = [
  "buyer_user_id",
  "buyer_username",
  "estimated_shipping_fee",
  "recipient_address",
  "actual_shipping_fee",
  "item_list",
  "pay_time",
  "total_amount",
  "shipping_carrier",
  "payment_method",
  "package_list",
  "note",
  "cancel_reason",
].join(",");
const SHIPPING_MODES = ["pickup", "dropoff", "non_integrated"];
const ORDER_SN_PROPERTY = { type: "string", minLength: 1, description: "Order number (order_sn)" };
const PACKAGE_NUMBER_PROPERTY = { type: "string", description: "Package number, only for orders split into several packages" };

export const orderOperations = [
  {
    name: "get_order_list",
    title: "List Shopee orders",
    description: "List order numbers created or updated in a time window of at most 15 days (Unix seconds), optionally by status.",
    parameters: {
      type: "object",
      properties: {
        time_range_field: { type: "string", enum: ["create_time", "update_time"], default: "create_time" },
        time_from: { type: "integer", description: "Window start, Unix seconds" },
        time_to: { type: "integer", description: "Window end, Unix seconds; at most 15 days after time_from" },
        order_status: { type: "string", enum: ORDER_STATUSES, description: "Only orders in this status" },
        limit: { type: "integer", minimum: 1, maximum: MAX_ORDERS_PER_PAGE, default: 50, description: "Page size (max 100)" },
        cursor: { type: "string", description: "next_cursor from a previous call" },
      },
      required: ["time_from", "time_to"],
    },
    run: listOrders,
  },
  {
    name: "get_order_detail",
    title: "Get Shopee order details",
    description: "Read up to 50 orders: items, amounts, buyer, recipient address, packages and shipping carrier.",
    parameters: {
      type: "object",
      properties: {
        order_sns: { type: "array", items: { type: "string" }, maxItems: MAX_ORDER_SNS, description: "1-50 order numbers" },
        response_optional_fields: { type: "string", default: DEFAULT_ORDER_DETAIL_FIELDS, description: "Comma-separated optional fields" },
      },
      required: ["order_sns"],
    },
    run: async ({ client, args, signal }) => {
      const query = { order_sn_list: joinIdList("order_sns", args.order_sns, MAX_ORDER_SNS), response_optional_fields: args.response_optional_fields };
      const body = await client.shop.request({ path: "/api/v2/order/get_order_detail", query, signal });
      return { data: extractShopeeResponse(body)?.order_list ?? [] };
    },
  },
  {
    name: "get_shipping_parameter",
    title: "Get Shopee shipping parameters",
    description: "Read what ship_order needs for an order (info_needed) and the pickup addresses/time slots or drop-off branches.",
    parameters: { type: "object", properties: { order_sn: ORDER_SN_PROPERTY, package_number: PACKAGE_NUMBER_PROPERTY }, required: ["order_sn"] },
    run: async ({ client, args, signal }) => {
      const query = { order_sn: args.order_sn, package_number: args.package_number };
      return { data: extractShopeeResponse(await client.shop.request({ path: "/api/v2/logistics/get_shipping_parameter", query, signal })) };
    },
  },
  {
    name: "ship_order",
    nodeOnly: true,
    title: "Ship a Shopee order",
    description:
      "Arrange shipment for an order with exactly one of pickup, dropoff or non_integrated, as get_shipping_parameter's info_needed says. " +
      "If this fails with a network error the order may still have been shipped: check with get_tracking_number or get_order_detail before retrying.",
    parameters: {
      type: "object",
      properties: {
        order_sn: ORDER_SN_PROPERTY,
        package_number: PACKAGE_NUMBER_PROPERTY,
        pickup: { type: "object", description: "{address_id, pickup_time_id, tracking_number?}; send {} if info_needed lists pickup with no fields" },
        dropoff: { type: "object", description: "{branch_id?, sender_real_name?, tracking_number?, slug?}; send {} if no fields are needed" },
        non_integrated: { type: "object", description: "{tracking_number?} for non-integrated channels" },
      },
      required: ["order_sn"],
    },
    run: async ({ client, args, signal }) => {
      const json = { order_sn: args.order_sn, package_number: args.package_number, ...pickShippingMode(args) };
      return { data: extractShopeeResponse(await client.shop.request({ method: "POST", path: "/api/v2/logistics/ship_order", json, signal })) };
    },
  },
  {
    name: "get_tracking_number",
    title: "Get Shopee tracking number",
    description: "Read the tracking number of a shipped order (empty until the carrier assigns one).",
    parameters: {
      type: "object",
      properties: {
        order_sn: ORDER_SN_PROPERTY,
        package_number: PACKAGE_NUMBER_PROPERTY,
        response_optional_fields: { type: "string", description: "e.g. plp_number,first_mile_tracking_number,last_mile_tracking_number" },
      },
      required: ["order_sn"],
    },
    run: async ({ client, args, signal }) => {
      const query = { order_sn: args.order_sn, package_number: args.package_number, response_optional_fields: args.response_optional_fields };
      return { data: extractShopeeResponse(await client.shop.request({ path: "/api/v2/logistics/get_tracking_number", query, signal })) };
    },
  },
];

async function listOrders({ client, args, signal }) {
  validateOrderTimeWindow(args.time_from, args.time_to);
  const query = {
    time_range_field: args.time_range_field,
    time_from: args.time_from,
    time_to: args.time_to,
    page_size: args.limit,
    cursor: args.cursor,
    order_status: args.order_status,
    response_optional_fields: "order_status",
  };
  const payload = extractShopeeResponse(await client.shop.request({ path: "/api/v2/order/get_order_list", query, signal }));
  return { data: payload?.order_list ?? [], next_cursor: payload?.more && payload.next_cursor ? String(payload.next_cursor) : null };
}

/**
 * Picks the single shipping mode object from the arguments.
 *
 * @param args - ship_order arguments (object)
 * @returns `{pickup}`, `{dropoff}` or `{non_integrated}` (object)
 * @throws PluginError kind `invalid_input` - When none or more than one mode is given
 */
export function pickShippingMode(args) {
  const givenModes = SHIPPING_MODES.filter((modeName) => args[modeName] !== undefined);
  if (givenModes.length !== 1) {
    rejectInput("Pass exactly one of `pickup`, `dropoff` or `non_integrated` (see get_shipping_parameter's info_needed)");
  }
  return { [givenModes[0]]: args[givenModes[0]] };
}
