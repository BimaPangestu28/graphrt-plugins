/**
 * rajaongkir plugin definition: the current RajaOngkir API by Komerce (https://rajaongkir.com/docs), which replaced
 * the old api.rajaongkir.com starter/basic/pro API in 2024/2025. Shipping cost quotes for Indonesian couriers,
 * destination search and waybill tracking. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Base URL https://rajaongkir.komerce.id/api/v1, key in the `key` header, responses are
 * {"meta": {"message", "code", "status"}, "data": ...}. Cost endpoints take form-urlencoded bodies.
 * An invalid key is answered with HTTP 400 and only a message, so lib/invalid-key-errors.mjs maps it to auth_error.
 *
 * Cost quotes are POSTs that only read; they are covered by the plan's daily hit quota (not billed per call), so
 * they are "idempotent" and retried after 5xx/network errors (a retry costs one more hit of the quota).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { mapInvalidKeyErrors } from "./lib/invalid-key-errors.mjs";

const searchParam = (description) => ({ in: "query", type: "string", required: true, minLength: 1, description });
const searchPagination = { dataPath: "data", offsetPagination: { offsetParam: "offset", limitParam: "limit" }, maxLimit: 100, defaultLimit: 10 };
const idPath = (description) => ({ in: "path", type: "string", required: true, description });

/** Body params of a cost quote; `originDescription`/`destinationDescription` say which ids are expected. */
function costParams(originDescription, destinationDescription) {
  return {
    origin: { in: "body", type: "string", required: true, description: originDescription },
    destination: { in: "body", type: "string", required: true, description: destinationDescription },
    weight: { in: "body", type: "integer", required: true, min: 1, description: "Weight in grams" },
    courier: { in: "body", type: "string", required: true, description: 'Courier codes separated by ":", e.g. "jne:sicepat:jnt:anteraja:pos:tiki"' },
    price: { in: "body", type: "string", enum: ["lowest", "highest"], description: "Sort by price" },
  };
}

function costOperation({ name, title, description, path, origin, destination }) {
  return { name, title, description, method: "POST", path, write: "idempotent", bodyMode: "form", params: costParams(origin, destination), response: { dataPath: "data" } };
}

const operations = [
  {
    name: "search_domestic_destinations",
    title: "Search domestic destinations",
    description: "Find destination ids for cost quotes by city, district, village or postal code: id, label, province/city/district/subdistrict, zip_code",
    path: "/destination/domestic-destination",
    params: { search: searchParam("City, district, village or postal code, e.g. coblong or 40132") },
    response: searchPagination,
  },
  {
    name: "search_international_destinations",
    title: "Search international destinations",
    description: "Find country ids for international quotes: country_id, country_name",
    path: "/destination/international-destination",
    params: { search: searchParam("Country name, e.g. malaysia") },
    response: searchPagination,
  },
  { name: "list_provinces", title: "List provinces", description: "Indonesian provinces: id, name", path: "/destination/province", response: { dataPath: "data" } },
  { name: "list_cities", title: "List cities", description: "Cities and regencies in a province: id, name, zip_code", path: "/destination/city/{province_id}", params: { province_id: idPath("Province id from list_provinces") }, response: { dataPath: "data" } },
  { name: "list_districts", title: "List districts", description: "Districts (kecamatan) in a city: id, name, zip_code", path: "/destination/district/{city_id}", params: { city_id: idPath("City id from list_cities") }, response: { dataPath: "data" } },
  {
    name: "list_subdistricts",
    title: "List subdistricts",
    description: "Subdistricts (kelurahan/desa) in a district: id, name, zip_code",
    path: "/destination/sub-district/{district_id}",
    params: { district_id: idPath("District id from list_districts") },
    response: { dataPath: "data" },
  },
  costOperation({
    name: "calculate_domestic_cost",
    title: "Domestic shipping cost",
    description: "Shipping cost quotes per courier and service: name, code, service, description, cost (IDR), etd",
    path: "/calculate/domestic-cost",
    origin: "Origin id from search_domestic_destinations",
    destination: "Destination id from search_domestic_destinations",
  }),
  costOperation({
    name: "calculate_district_cost",
    title: "Domestic cost by district",
    description: "Shipping cost quotes between two districts (ids from list_districts): name, code, service, cost, etd",
    path: "/calculate/district/domestic-cost",
    origin: "Origin district id from list_districts",
    destination: "Destination district id from list_districts",
  }),
  costOperation({
    name: "calculate_international_cost",
    title: "International shipping cost",
    description: "International quotes from Indonesia: name, code, service, cost, currency, etd",
    path: "/calculate/international-cost",
    origin: "Origin id from search_domestic_destinations",
    destination: "Country id from search_international_destinations",
  }),
  {
    name: "track_waybill",
    title: "Track a waybill",
    description: "Tracking of a waybill (resi): delivered, summary, details, delivery_status and manifest history",
    method: "POST",
    path: "/track/waybill",
    write: "idempotent",
    bodyMode: "form",
    params: {
      awb: { in: "query", type: "string", required: true, minLength: 1, description: "Waybill (resi) number" },
      courier: { in: "query", type: "string", required: true, description: "Courier code: jne, pos, tiki, sap, ninja, jnt, wahana, lion, spx" },
      last_phone_number: { in: "body", type: "string", description: "Last 5 digits of the receiver's phone (needed by some couriers, e.g. JNE)" },
    },
    response: { dataPath: "data" },
  },
];

export const restDefinition = defineRestPlugin({
  name: "rajaongkir",
  version: "0.1.0",
  description: "RajaOngkir by Komerce: Indonesian shipping cost quotes (domestic and international), destination search and waybill tracking",
  apiName: "RajaOngkir (Komerce) API",
  baseUrl: "https://rajaongkir.komerce.id/api/v1",
  auth: { type: "header", header: "key", env: "RAJAONGKIR_API_KEY" },
  errors: { messagePath: "meta.message" },
  apiRequest: { examplePath: "/destination/province" },
  operations,
});

export const pluginDefinition = mapInvalidKeyErrors(restDefinition);
