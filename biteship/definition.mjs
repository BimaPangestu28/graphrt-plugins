/**
 * biteship plugin definition: Indonesian shipping through Biteship (https://biteship.com/en/docs/api): courier rates,
 * area search, orders (courier bookings), cancellation and tracking. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * Money: `create_order` books a courier and draws the shipping fee from the Biteship balance, and `cancel_order`
 * cancels a booking, so both are nodeOnly. Rate checks are billed per request beyond the plan's quota (Rp5 each,
 * Starter includes none), so `get_rates` is "unsafe": never retried after an unknown outcome.
 * Test keys (biteship_test.) use the same host and do not create real bookings.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const RATE_CHECK_HINT = "a rate check may have been billed against the quota or Bitepoints; it changed nothing, so retrying only costs another check";
const ORDER_CHECK_HINT = "retry with the same reference_id: Biteship refuses a duplicate reference_id and returns the existing order_id (or look in the dashboard)";
const string = (description, extra = {}) => ({ in: "body", type: "string", description, ...extra });
const number = (description, extra = {}) => ({ in: "body", type: "number", description, ...extra });
const required = { required: true };
const itemsParam = {
  in: "body",
  type: "array",
  items: { type: "object" },
  required: true,
  maxItems: 100,
  description: 'Items: [{"name": "Shirt", "value": 150000, "quantity": 1, "weight": 300, "length": 30, "width": 20, "height": 2}] (value in IDR, weight in grams, sizes in cm)',
};
const codTypeParam = (wireName) => ({ in: "body", type: "string", enum: ["3_days", "5_days", "7_days"], wireName, description: "COD settlement period" });

/** Location fields for one side ("origin" or "destination") of a rate check. */
function rateLocationParams(side) {
  return {
    [`${side}_area_id`]: string(`${side} area id from search_areas`),
    [`${side}_postal_code`]: { in: "body", type: "integer", description: `${side} postal code, e.g. 12440` },
    [`${side}_latitude`]: number(`${side} latitude (needed for instant couriers such as gojek, grab)`),
    [`${side}_longitude`]: number(`${side} longitude`),
  };
}

/** Contact and location fields for one side of an order. */
function orderPartyParams(side) {
  return {
    [`${side}_contact_name`]: string(`${side} contact name`, required),
    [`${side}_contact_phone`]: string(`${side} contact phone, e.g. 08123456789`, required),
    [`${side}_contact_email`]: string(`${side} contact email`),
    [`${side}_address`]: string(`${side} full address`, required),
    [`${side}_note`]: string(`${side} address note, e.g. landmark`),
    [`${side}_postal_code`]: { in: "body", type: "integer", description: `${side} postal code` },
    [`${side}_area_id`]: string(`${side} area id from search_areas`),
    [`${side}_coordinate`]: { in: "body", type: "object", description: `${side} {"latitude": ..., "longitude": ...} (required for instant couriers)` },
  };
}

const getRates = {
  name: "get_rates",
  title: "Courier rates",
  description: "Shipping prices and ETAs from couriers between two places (area id, postal code or coordinates) for the items",
  method: "POST",
  path: "/v1/rates/couriers",
  write: "unsafe",
  checkHint: RATE_CHECK_HINT,
  params: {
    ...rateLocationParams("origin"),
    ...rateLocationParams("destination"),
    couriers: string('Comma-separated courier codes, e.g. "jne,sicepat,jnt,anteraja,gojek" (see list_couriers)', required),
    items: itemsParam,
    courier_insurance: number("Insured value in IDR"),
    destination_cash_on_delivery: number("COD amount in IDR (up to 15,000,000)"),
    destination_cash_on_delivery_type: codTypeParam(undefined),
  },
  response: { dataPath: "pricing" },
};

const listCouriers = {
  name: "list_couriers",
  title: "List couriers",
  description: "Couriers and services available to the account: courier_code, courier_service_code, tier, duration, COD/insurance support",
  path: "/v1/couriers",
  response: { dataPath: "couriers" },
};

const searchAreas = {
  name: "search_areas",
  title: "Search areas",
  description: "Find area ids for rates and orders by name or postal code: id, name, province/city/district, postal_code",
  path: "/v1/maps/areas",
  params: {
    input: { in: "query", type: "string", required: true, minLength: 3, description: "Place name or postal code, e.g. 'Kebayoran Baru' or 12120" },
    countries: { in: "query", type: "string", default: "ID", description: "Country code (ID)" },
    search_type: { in: "query", type: "string", enum: ["single", "double"], default: "single", wireName: "type", description: "single: one search (default)" },
  },
  response: { dataPath: "areas" },
};

const createOrder = {
  name: "create_order",
  title: "Create order (book a courier)",
  description: "Book a courier pickup or drop-off for a shipment; the fee is charged to the Biteship balance. Returns id, status, courier.waybill_id",
  method: "POST",
  path: "/v1/orders",
  write: "unsafe",
  checkHint: ORDER_CHECK_HINT,
  nodeOnly: true,
  params: {
    shipper_contact_name: string("Sender name on the label (default: account)"),
    shipper_contact_phone: string("Sender phone on the label"),
    shipper_contact_email: string("Sender email"),
    shipper_organization: string("Sender organization"),
    ...orderPartyParams("origin"),
    origin_collection_method: string("pickup or drop_off", { enum: ["pickup", "drop_off"] }),
    ...orderPartyParams("destination"),
    destination_cash_on_delivery: number("COD amount in IDR"),
    destination_cash_on_delivery_type: codTypeParam(undefined),
    courier_company: string("Courier code, e.g. jne (from get_rates)", required),
    courier_type: string("Service code, e.g. reg (from get_rates courier_service_code)", required),
    courier_insurance: number("Insured value in IDR"),
    delivery_type: string("now or scheduled", { required: true, enum: ["now", "scheduled"] }),
    delivery_date: string("Scheduled date, YYYY-MM-DD"),
    delivery_time: string("Scheduled time, HH:mm"),
    order_note: string("Note for the courier"),
    reference_id: string("Your unique order reference; a duplicate is refused, which makes retries safe"),
    metadata: { in: "body", type: "object", description: "Your own key-value data" },
    tags: { in: "body", type: "array", items: { type: "string" }, maxItems: 20, description: "Tags" },
    items: itemsParam,
  },
};

const getOrder = {
  name: "get_order",
  title: "Get order",
  description: "One order: status, courier (waybill_id, tracking_id, history), origin, destination, items and price",
  path: "/v1/orders/{order_id}",
  params: { order_id: { in: "path", type: "string", required: true, description: "Biteship order id" } },
};

const cancelOrder = {
  name: "cancel_order",
  title: "Cancel order",
  description: "Cancel a booked order (only before pickup); see list_cancellation_reasons",
  method: "POST",
  path: "/v1/orders/{order_id}/cancel",
  write: "unsafe",
  checkHint: "get_order and look at status (cancelled)",
  nodeOnly: true,
  params: {
    order_id: { in: "path", type: "string", required: true, description: "Biteship order id" },
    cancellation_reason_code: string("Reason code, e.g. change_courier, others (see list_cancellation_reasons)", required),
    cancellation_reason: string("Free-text reason"),
  },
};

const listCancellationReasons = {
  name: "list_cancellation_reasons",
  title: "Cancellation reasons",
  description: "Codes accepted by cancel_order with descriptions",
  path: "/v1/orders/cancellation_reasons",
  params: { lang: { in: "query", type: "string", enum: ["id", "en"], default: "en", description: "Language of the descriptions" } },
};

const getTracking = {
  name: "get_tracking",
  title: "Track an order",
  description: "Tracking of an order made through Biteship: status, waybill_id, link, courier driver, history [{note, status, updated_at}]",
  path: "/v1/trackings/{tracking_id}",
  params: { tracking_id: { in: "path", type: "string", required: true, description: "courier.tracking_id of the order" } },
};

const trackWaybill = {
  name: "track_waybill",
  title: "Track a waybill",
  description: "Public tracking of any waybill (also shipments not booked through Biteship): status and history",
  path: "/v1/trackings/{waybill_id}/couriers/{courier_code}",
  params: {
    waybill_id: { in: "path", type: "string", required: true, description: "Waybill (resi) number" },
    courier_code: { in: "path", type: "string", required: true, description: "Courier code, e.g. jne, sicepat, jnt" },
  },
};

export const pluginDefinition = defineRestPlugin({
  name: "biteship",
  version: "0.1.0",
  description: "Biteship Indonesian shipping: courier rates, couriers, area search, orders (node only), cancellation (node only) and tracking",
  apiName: "Biteship API",
  baseUrl: "https://api.biteship.com",
  // The key is sent as the whole Authorization header (Bearer is optional per the docs).
  auth: { type: "header", header: "Authorization", env: "BITESHIP_API_KEY" },
  // {"success": false, "error": "...", "code": 40000001}
  errors: {
    messagePath: ["error", "message"],
    codePath: "code",
    kindByCode: { 40000001: "auth_error", 40100000: "auth_error", 40200000: "permission_denied" },
    kindByStatus: { 402: "permission_denied" },
  },
  apiRequest: { examplePath: "/v1/couriers" },
  operations: [getRates, listCouriers, searchAreas, createOrder, getOrder, cancelOrder, listCancellationReasons, getTracking, trackWaybill],
});
