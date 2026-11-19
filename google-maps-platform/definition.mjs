/**
 * google-maps-platform plugin definition: Places API (New), Geocoding API v4 and Routes API with one API key
 * (X-Goog-Api-Key). Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Billing: every request is billed per call (or per matrix element) once the monthly free cap is used, and the
 * SKU depends on the fields requested, so each operation sends an explicit X-Goog-FieldMask with a cheap default
 * and every operation is `write: "unsafe"`: never retried after a 5xx, timeout or network error (Google may
 * already have billed it). 429s are retried.
 *
 * Agent tools may compute route matrices of at most GOOGLE_MAPS_TOOL_MAX_MATRIX_ELEMENTS elements
 * (lib/matrix-limit.mjs) and request only Essentials/Pro place fields unless
 * GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS=1 (lib/field-mask-policy.mjs); nodes get Google's own limits.
 * get_place_photo only accepts places/<id>/photos/<id> names (lib/photo-name.mjs).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { EXPENSIVE_FIELDS_ENV, limitToolFieldMasks } from "./lib/field-mask-policy.mjs";
import { limitToolMatrixElements, MATRIX_LIMIT_ENV } from "./lib/matrix-limit.mjs";
import { requirePhotoName } from "./lib/photo-name.mjs";

const PLACES_URL = "https://places.googleapis.com/v1";
const GEOCODING_URL = "https://geocode.googleapis.com/v4";
const ROUTES_URL = "https://routes.googleapis.com";
const BILLING_HINT = "the request may have been billed; see APIs & Services > Metrics in the Google Cloud console before retrying";
const PLACE_FIELDS = "id,displayName,formattedAddress,location,googleMapsUri,types,primaryType,businessStatus";
const SEARCH_FIELDS = `${PLACE_FIELDS.split(",").map((field) => `places.${field}`).join(",")},nextPageToken`;
const TRAVEL_MODES = ["DRIVE", "BICYCLE", "WALK", "TWO_WHEELER", "TRANSIT"];
const ROUTING_PREFERENCES = ["TRAFFIC_UNAWARE", "TRAFFIC_AWARE", "TRAFFIC_AWARE_OPTIMAL"];

const fieldMask = (defaultMask, pricingNote) => ({
  in: "header",
  type: "string",
  wireName: "X-Goog-FieldMask",
  default: defaultMask,
  minLength: 1,
  description: `Comma-separated response fields (no spaces). The fields decide the billed SKU: ${pricingNote}`,
});
const bodyString = (wireName, description) => ({ in: "body", type: "string", wireName, description });
const languageCode = bodyString("languageCode", "Language of the results, e.g. en, id");
const regionCode = bodyString("regionCode", "Two-letter region code that biases results, e.g. ID");
const placesFieldNote = "id/displayName/formattedAddress/location are Pro; rating, phone, website, hours are Enterprise; reviews are Enterprise + Atmosphere";
const billedPost = { method: "POST", write: "unsafe", checkHint: BILLING_HINT };
const billedGet = { method: "GET", write: "unsafe", checkHint: BILLING_HINT };

const searchText = {
  ...billedPost,
  name: "search_text",
  title: "Search places by text",
  description: 'Find places from a text query such as "coffee near Monas Jakarta": places with id, name, address, location, Maps URL',
  path: "/places:searchText",
  params: {
    text_query: { in: "body", type: "string", required: true, minLength: 1, wireName: "textQuery", description: "What and where, e.g. 'pharmacy in Bandung'" },
    included_type: bodyString("includedType", "Only this place type, e.g. restaurant, lodging"),
    strict_type_filtering: { in: "body", type: "boolean", wireName: "strictTypeFiltering", description: "Only return included_type" },
    open_now: { in: "body", type: "boolean", wireName: "openNow", description: "Only places open now" },
    min_rating: { in: "body", type: "number", min: 0, max: 5, wireName: "minRating", description: "Minimum average rating (0-5, steps of 0.5)" },
    price_levels: { in: "body", type: "array", items: { type: "string" }, maxItems: 4, wireName: "priceLevels", description: "e.g. [PRICE_LEVEL_INEXPENSIVE, PRICE_LEVEL_MODERATE]" },
    location_bias: { in: "body", type: "object", wireName: "locationBias", description: '{"circle": {"center": {"latitude": -6.2, "longitude": 106.8}, "radius": 5000}} or a rectangle' },
    location_restriction: { in: "body", type: "object", wireName: "locationRestriction", description: '{"rectangle": {"low": {...}, "high": {...}}} (not with location_bias)' },
    language_code: languageCode,
    region_code: regionCode,
    field_mask: fieldMask(SEARCH_FIELDS, `${placesFieldNote}; keep nextPageToken for paging`),
  },
  response: { dataPath: "places", cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 20 },
};

const searchNearby = {
  ...billedPost,
  name: "search_nearby",
  title: "Search places nearby",
  description: "Places of given types within a radius of a point, by popularity or distance",
  path: "/places:searchNearby",
  params: {
    latitude: { in: "body", type: "number", required: true, min: -90, max: 90, wireName: "locationRestriction.circle.center.latitude", description: "Center latitude" },
    longitude: { in: "body", type: "number", required: true, min: -180, max: 180, wireName: "locationRestriction.circle.center.longitude", description: "Center longitude" },
    radius_meters: { in: "body", type: "number", required: true, min: 1, max: 50000, wireName: "locationRestriction.circle.radius", description: "Radius in meters (up to 50000)" },
    included_types: { in: "body", type: "array", items: { type: "string" }, maxItems: 50, wireName: "includedTypes", description: "Place types, e.g. [restaurant, cafe]" },
    excluded_types: { in: "body", type: "array", items: { type: "string" }, maxItems: 50, wireName: "excludedTypes", description: "Types to leave out" },
    max_result_count: { in: "body", type: "integer", min: 1, max: 20, wireName: "maxResultCount", description: "Maximum places (1-20, default 20)" },
    rank_preference: { in: "body", type: "string", enum: ["POPULARITY", "DISTANCE"], wireName: "rankPreference", description: "Order (default POPULARITY)" },
    language_code: languageCode,
    region_code: regionCode,
    field_mask: fieldMask(SEARCH_FIELDS.replace(",nextPageToken", ""), placesFieldNote),
  },
  response: { dataPath: "places" },
};

const getPlace = {
  ...billedGet,
  name: "get_place",
  title: "Place details",
  description: "Details of one place by id; ask for rating, phone, website or opening hours through field_mask",
  path: "/places/{place_id}",
  params: {
    place_id: { in: "path", type: "string", required: true, description: "Place id from search_text, search_nearby or autocomplete" },
    language_code: { in: "query", type: "string", wireName: "languageCode", description: "Language, e.g. en, id" },
    region_code: { in: "query", type: "string", wireName: "regionCode", description: "Region code, e.g. ID" },
    session_token: { in: "query", type: "string", wireName: "sessionToken", description: "Autocomplete session token, to bill the session as one" },
    field_mask: fieldMask(PLACE_FIELDS, `${placesFieldNote}. Example: ${PLACE_FIELDS},rating,nationalPhoneNumber,websiteUri,regularOpeningHours`),
  },
};

const autocompletePlaces = {
  ...billedPost,
  name: "autocomplete_places",
  title: "Autocomplete places",
  description: "Place and query predictions for partial input (suggestions[].placePrediction.placeId and text)",
  path: "/places:autocomplete",
  params: {
    input: { in: "body", type: "string", required: true, minLength: 1, description: "Text typed so far" },
    included_primary_types: { in: "body", type: "array", items: { type: "string" }, maxItems: 5, wireName: "includedPrimaryTypes", description: "Up to 5 types, or [(regions)] / [(cities)]" },
    included_region_codes: { in: "body", type: "array", items: { type: "string" }, maxItems: 15, wireName: "includedRegionCodes", description: "Only these regions, e.g. [id]" },
    include_query_predictions: { in: "body", type: "boolean", wireName: "includeQueryPredictions", description: "Also suggest queries" },
    location_bias: { in: "body", type: "object", wireName: "locationBias", description: '{"circle": {"center": {"latitude": ..., "longitude": ...}, "radius": 5000}}' },
    origin: { in: "body", type: "object", description: '{"latitude": ..., "longitude": ...} to get distanceMeters' },
    session_token: bodyString("sessionToken", "Session token (a UUID) shared with the following get_place call"),
    language_code: languageCode,
    region_code: regionCode,
  },
};

const getPlacePhoto = {
  ...billedGet,
  name: "get_place_photo",
  title: "Place photo URL",
  description: "A short-lived photoUri for a photo from a place's photos[].name",
  path: "/{+photo_name}/media",
  params: {
    photo_name: { in: "path", type: "string", required: true, description: "photos[].name, e.g. places/ChIJ.../photos/Aap..." },
    max_width_px: { in: "query", type: "integer", min: 1, max: 4800, default: 800, wireName: "maxWidthPx", description: "Maximum width in pixels (1-4800)" },
    max_height_px: { in: "query", type: "integer", min: 1, max: 4800, wireName: "maxHeightPx", description: "Maximum height in pixels (1-4800)" },
  },
  constants: { query: { skipHttpRedirect: "true" } },
};

const geocodeAddress = {
  ...billedGet,
  name: "geocode_address",
  title: "Geocode an address",
  description: "Address to coordinates: results[] with placeId, formattedAddress, location {latitude, longitude}, addressComponents, types",
  baseUrl: GEOCODING_URL,
  path: "/geocode/address",
  params: {
    address: { in: "query", type: "string", required: true, minLength: 1, wireName: "addressQuery", description: "Address, e.g. 'Jl. M.H. Thamrin No.1, Jakarta'" },
    language_code: { in: "query", type: "string", wireName: "languageCode", description: "Language of the results" },
    region_code: { in: "query", type: "string", wireName: "regionCode", description: "Region code that biases results, e.g. ID" },
  },
};

const reverseGeocode = {
  ...billedGet,
  name: "reverse_geocode",
  title: "Reverse geocode",
  description: "Coordinates to addresses: results[] with formattedAddress, placeId, addressComponents, types",
  baseUrl: GEOCODING_URL,
  path: "/geocode/location",
  params: {
    latitude: { in: "query", type: "number", required: true, min: -90, max: 90, wireName: "location.latitude", description: "Latitude" },
    longitude: { in: "query", type: "number", required: true, min: -180, max: 180, wireName: "location.longitude", description: "Longitude" },
    language_code: { in: "query", type: "string", wireName: "languageCode", description: "Language of the results" },
    region_code: { in: "query", type: "string", wireName: "regionCode", description: "Region code, e.g. ID" },
  },
};

const routeOptions = {
  travel_mode: { in: "body", type: "string", enum: TRAVEL_MODES, wireName: "travelMode", default: "DRIVE", description: "Travel mode" },
  routing_preference: { in: "body", type: "string", enum: ROUTING_PREFERENCES, wireName: "routingPreference", description: "DRIVE/TWO_WHEELER only; TRAFFIC_AWARE* bills the Pro SKU" },
  language_code: languageCode,
  units: { in: "body", type: "string", enum: ["METRIC", "IMPERIAL"], description: "Units of localized values" },
};
const waypointDescription = 'A waypoint: {"address": "Monas, Jakarta"}, {"placeId": "ChIJ..."} or {"location": {"latLng": {"latitude": -6.17, "longitude": 106.82}}}';

const computeRoutes = {
  ...billedPost,
  name: "compute_routes",
  title: "Compute a route",
  description: "Route between two waypoints (optionally via intermediates): distanceMeters, duration (e.g. '1234s'), localized values",
  baseUrl: ROUTES_URL,
  path: "/directions/v2:computeRoutes",
  params: {
    origin: { in: "body", type: "object", required: true, description: waypointDescription },
    destination: { in: "body", type: "object", required: true, description: waypointDescription },
    intermediates: { in: "body", type: "array", items: { type: "object" }, maxItems: 25, description: "Stops in between (up to 25)" },
    ...routeOptions,
    compute_alternative_routes: { in: "body", type: "boolean", wireName: "computeAlternativeRoutes", description: "Also return alternatives" },
    route_modifiers: { in: "body", type: "object", wireName: "routeModifiers", description: '{"avoidTolls": true, "avoidHighways": false, "avoidFerries": true}' },
    departure_time: bodyString("departureTime", "RFC 3339 time, e.g. 2026-11-20T08:00:00Z (traffic-aware routing)"),
    field_mask: fieldMask("routes.distanceMeters,routes.duration,routes.description,routes.localizedValues", "add routes.polyline.encodedPolyline or routes.legs for more; traffic or 11+ intermediates bill Pro"),
  },
  response: { dataPath: "routes" },
};

const computeRouteMatrix = {
  ...billedPost,
  name: "compute_route_matrix",
  title: "Compute a route matrix",
  description: "Distance and duration for every origin-destination pair (billed per element): [{originIndex, destinationIndex, distanceMeters, duration, condition}]",
  baseUrl: ROUTES_URL,
  path: "/distanceMatrix/v2:computeRouteMatrix",
  params: {
    origins: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 50, description: `Origins: [{"waypoint": ...}], where waypoint is ${waypointDescription}` },
    destinations: { in: "body", type: "array", items: { type: "object" }, required: true, maxItems: 50, description: "Destinations: [{waypoint: ...}]" },
    ...routeOptions,
    field_mask: fieldMask("originIndex,destinationIndex,status,condition,distanceMeters,duration,localizedValues", "elements are Essentials, Pro with traffic"),
  },
};

const restDefinition = defineRestPlugin({
  name: "google-maps-platform",
  version: "0.1.0",
  description: "Google Maps Platform (billed per call): Places API (New) search, details, autocomplete and photos; Geocoding v4; Routes routes and matrices",
  apiName: "Google Maps Platform",
  extraEnv: [MATRIX_LIMIT_ENV, EXPENSIVE_FIELDS_ENV],
  baseUrl: PLACES_URL,
  auth: { type: "header", header: "X-Goog-Api-Key", env: "GOOGLE_MAPS_API_KEY" },
  // {"error": {"code": 400, "message": "API key not valid...", "status": "INVALID_ARGUMENT", "details": [{"reason": "API_KEY_INVALID"}]}}
  errors: {
    messagePath: "error.message",
    codePath: "error.details.0.reason",
    kindByCode: {
      API_KEY_INVALID: "auth_error",
      API_KEY_EXPIRED: "auth_error",
      API_KEY_SERVICE_BLOCKED: "permission_denied",
      API_KEY_HTTP_REFERRER_BLOCKED: "permission_denied",
      API_KEY_IP_ADDRESS_BLOCKED: "permission_denied",
      SERVICE_DISABLED: "permission_denied",
      BILLING_DISABLED: "permission_denied",
      RATE_LIMIT_EXCEEDED: "rate_limited",
      RESOURCE_EXHAUSTED: "rate_limited",
    },
  },
  // Every endpoint is billed and needs a field mask, so there is no generic api_request.
  apiRequest: false,
  operations: [searchText, searchNearby, getPlace, autocompletePlaces, getPlacePhoto, geocodeAddress, reverseGeocode, computeRoutes, computeRouteMatrix],
});

export { restDefinition };
const fieldMaskPolicy = { searchOperations: ["search_text", "search_nearby"], detailOperations: ["get_place"] };
export const pluginDefinition = requirePhotoName(
  limitToolFieldMasks(limitToolMatrixElements(restDefinition, "compute_route_matrix"), fieldMaskPolicy),
  "get_place_photo",
);
