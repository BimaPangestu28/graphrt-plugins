/**
 * shipper plugin definition: Shipper.id logistics API v3 (https://logistics-docs.shipper.id): locations, domestic
 * rates, orders, pickups, labels and tracking for Indonesian couriers. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * SHIPPER_ENVIRONMENT picks production (merchant-api.shipper.id, default) or sandbox
 * (merchant-api-sandbox.shipper.id); keys are per environment. The key goes in X-API-Key.
 * Creating and cancelling orders and requesting pickups book or cancel real couriers, so they are nodeOnly.
 * Rate quotes are free POSTs that only read ("idempotent"); their item_categories are checked against Shipper's
 * list by lib/item-categories.mjs.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { checkItemCategories, ITEM_CATEGORIES } from "./lib/item-categories.mjs";

const ENVIRONMENT_ENV = "SHIPPER_ENVIRONMENT";
const BASE_URLS = { production: "https://merchant-api.shipper.id", sandbox: "https://merchant-api-sandbox.shipper.id" };
const ORDER_CHECK_HINT = "get_order_by_external_id with the external_id you sent (or look in the Shipper dashboard)";
const pagedList = { dataPath: "data", pagePagination: { pageParam: "page", sizeParam: "limit", totalPagesPath: "pagination.total_pages" }, maxLimit: 100, defaultLimit: 50 };
const idPath = (description) => ({ in: "path", type: "string", required: true, description });
const object = (description, extra = {}) => ({ in: "body", type: "object", description, ...extra });
const number = (description, extra = {}) => ({ in: "body", type: "number", description, ...extra });
const required = { required: true };
const MAX_ORDERS_PER_CALL = 30;
const locationObject = (side) => object(`${side}: {"area_id": 4711, "lat": "-6.2", "lng": "106.8", "suburb_id": 482} (area from the location operations; lat/lng as strings)`, required);

/**
 * Picks the API host from SHIPPER_ENVIRONMENT.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws Error - When SHIPPER_ENVIRONMENT is neither production nor sandbox (becomes invalid_input)
 */
export function resolveShipperUrl(environment) {
  const environmentName = environment?.[ENVIRONMENT_ENV]?.trim().toLowerCase() || "production";
  if (!BASE_URLS[environmentName]) throw new Error(`${ENVIRONMENT_ENV} must be production or sandbox`);
  return BASE_URLS[environmentName];
}

function locationList(name, title, description, path, pathParam) {
  return { name, title, description, path, params: pathParam ? { [pathParam.name]: idPath(pathParam.description) } : {}, response: pagedList };
}

const searchLocations = {
  name: "search_locations",
  title: "Search locations",
  description: "Find areas by name: adm_level_1..5 (country to area) with ids, display_txt and postcodes",
  path: "/v3/location",
  params: {
    keyword: { in: "query", type: "string", required: true, minLength: 3, description: "Place name, at least 3 characters, e.g. Kebayoran" },
    adm_level: { in: "query", type: "integer", min: 1, max: 5, description: "Only this level: 1 country, 2 province, 3 city, 4 suburb, 5 area" },
    limit: { in: "query", type: "integer", min: 1, max: 100, description: "Maximum results" },
  },
  response: { dataPath: "data" },
};

const getDomesticRates = {
  name: "get_domestic_rates",
  title: "Domestic rates",
  description: "Courier prices for a parcel: pricings[] with logistic {name, code}, rate {id, name, type}, final_price, insurance, min_day/max_day",
  method: "POST",
  path: "/v3/pricing/domestic",
  write: "idempotent",
  params: {
    origin: locationObject("Origin"),
    destination: locationObject("Destination"),
    weight: number("Weight in kg, more than 0, e.g. 1.5", { required: true, min: 0.001 }),
    package_length: number("Length in cm", { required: true, wireName: "length" }),
    package_width: number("Width in cm", { required: true, wireName: "width" }),
    package_height: number("Height in cm", { required: true, wireName: "height" }),
    item_value: number("Item value in IDR", required),
    item_categories: {
      in: "body",
      type: "array",
      items: { type: "string", enum: ITEM_CATEGORIES },
      maxItems: ITEM_CATEGORIES.length,
      description: `Optional item categories, e.g. ["Pakaian"]: ${ITEM_CATEGORIES.join(", ")}`,
    },
    for_order: { in: "body", type: "boolean", default: true, description: "Only rates that can be ordered" },
    cod_amount: number("COD amount in IDR: quotes couriers that support cash on delivery (the account must be whitelisted for COD)"),
    rate_types: { in: "body", type: "array", items: { type: "string", enum: ["instant", "regular", "express", "trucking", "same-day"] }, maxItems: 5, wireName: "rate_type", description: "Only these rate types" },
    sort_by: { in: "body", type: "array", items: { type: "string" }, maxItems: 5, description: 'Sort fields, e.g. ["final_price"]' },
  },
  response: { dataPath: "data" },
};

const createOrder = {
  name: "create_order",
  title: "Create order",
  description: "Create a shipment order with a rate_id from get_domestic_rates; returns data.order_id. A courier is dispatched after request_pickup",
  method: "POST",
  path: "/v3/order",
  write: "unsafe",
  checkHint: ORDER_CHECK_HINT,
  nodeOnly: true,
  params: {
    consignee: object('Receiver: {"name": "Budi", "phone_number": "6281200000002", "email": "budi@example.com"}', required),
    consigner: object("Sender: {name, phone_number, email}", required),
    coverage: { in: "body", type: "string", enum: ["domestic", "international"], default: "domestic", description: "Coverage" },
    courier: object('{"rate_id": 58, "use_insurance": false, "cod": false, "cod_amount": 0}', required),
    origin: object('{"area_id": 4711, "address": "Jl. Sudirman 1", "lat": "-6.2", "lng": "106.8"}', required),
    destination: object('{"area_id": 12345, "address": "Jl. Asia Afrika 2", "lat": "...", "lng": "..."}', required),
    package: object('{"weight": 1, "length": 10, "width": 10, "height": 5, "price": 150000, "package_type": 2, "items": [{"name": "Kemeja", "price": 150000, "qty": 1}]}', required),
    external_id: { in: "body", type: "string", description: "Your own order reference (lets you find the order with get_order_by_external_id)" },
    payment_type: { in: "body", type: "string", enum: ["cash", "postpay"], default: "postpay", description: "How Shipper is paid" },
  },
  response: { dataPath: "data" },
};

const getOrder = {
  name: "get_order",
  title: "Get order (with tracking)",
  description: "One order with awb_number, shipment_status and trackings [{shipper_status, logistic_status, created_date}]",
  path: "/v3/order/{order_id}",
  params: { order_id: idPath("Shipper order id") },
  response: { dataPath: "data" },
};

const getOrderByExternalId = {
  name: "get_order_by_external_id",
  title: "Get order by external id",
  description: "The order created with your external_id, with its tracking",
  path: "/v3/order/external-id/{external_id}",
  params: { external_id: idPath("external_id sent to create_order") },
  response: { dataPath: "data" },
};

const cancelOrder = {
  name: "cancel_order",
  title: "Cancel order",
  description: "Cancel an order before pickup",
  method: "DELETE",
  path: "/v3/order/{order_id}",
  write: "unsafe",
  checkHint: "get_order and look at shipment_status",
  nodeOnly: true,
  params: { order_id: idPath("Shipper order id"), reason: { in: "body", type: "string", required: true, description: "Why the order is cancelled" } },
  response: { dataPath: "data" },
};

const requestPickup = {
  name: "request_pickup",
  title: "Request pickup",
  description: "Activate orders for pickup at a time: a courier is dispatched",
  method: "POST",
  path: "/v3/pickup",
  write: "unsafe",
  checkHint: "get_order for each order and look at pickup_code / time_slot_selected",
  nodeOnly: true,
  params: {
    order_ids: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: MAX_ORDERS_PER_CALL, wireName: "data.order_activation.order_id", description: "Order ids to pick up" },
    pickup_time: { in: "body", type: "string", wireName: "data.order_activation.pickup_time", description: "Pickup time, RFC 3339, e.g. 2026-11-20T10:00:00+07:00" },
  },
  response: { dataPath: "data" },
};

const createLabel = {
  name: "create_label",
  title: "Shipping label",
  description: "A printable label (LBL) or receipt (RCP) for orders: data with the document URL",
  method: "POST",
  path: "/v3/order/label",
  write: "idempotent",
  params: {
    order_ids: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: MAX_ORDERS_PER_CALL, wireName: "id", description: "Order ids" },
    label_type: { in: "body", type: "string", enum: ["LBL", "RCP"], default: "LBL", wireName: "type", description: "LBL label or RCP receipt" },
  },
  response: { dataPath: "data" },
};

export const restDefinition = defineRestPlugin({
  name: "shipper",
  version: "0.1.0",
  description: "Shipper.id logistics: locations, domestic rates, orders with tracking, labels; creating, cancelling and pickups node only",
  apiName: "Shipper API v3",
  extraEnv: [ENVIRONMENT_ENV],
  baseUrl: resolveShipperUrl,
  auth: { type: "header", header: "X-API-Key", env: "SHIPPER_API_KEY" },
  // {"metadata": {"http_status_code": 403, "errors": [{"code": 70002, "message": "Unauthorized Access. ..."}]}}
  errors: {
    messagePath: ["metadata.errors.0.message", "metadata.http_status"],
    codePath: "metadata.errors.0.code",
    kindByCode: { 10001: "auth_error", 70002: "auth_error" },
  },
  apiRequest: { examplePath: "/v3/location/countries" },
  operations: [
    searchLocations,
    locationList("list_countries", "List countries", "Countries: country_id, country_name (Indonesia is 228)", "/v3/location/countries"),
    locationList("list_provinces", "List provinces", "Provinces of a country", "/v3/location/country/{country_id}/provinces", { name: "country_id", description: "Country id (Indonesia: 228)" }),
    locationList("list_cities", "List cities", "Cities of a province", "/v3/location/province/{province_id}/cities", { name: "province_id", description: "Province id" }),
    locationList("list_suburbs", "List suburbs", "Suburbs (kecamatan) of a city", "/v3/location/city/{city_id}/suburbs", { name: "city_id", description: "City id" }),
    locationList("list_areas", "List areas", "Areas (kelurahan) of a suburb with postcode, lat and lng", "/v3/location/suburb/{suburb_id}/areas", { name: "suburb_id", description: "Suburb id" }),
    getDomesticRates,
    createOrder,
    getOrder,
    getOrderByExternalId,
    cancelOrder,
    requestPickup,
    createLabel,
  ],
});

export const pluginDefinition = checkItemCategories(restDefinition, "get_domestic_rates");
