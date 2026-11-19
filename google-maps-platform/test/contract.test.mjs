import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition, restDefinition } from "../definition.mjs";

const PLACES = "https://places.googleapis.com/v1";
const GEOCODE = "https://geocode.googleapis.com/v4";
const ROUTES = "https://routes.googleapis.com";
const PLACE_FIELDS = "id,displayName,formattedAddress,location,googleMapsUri,types,primaryType,businessStatus";
const NEARBY_FIELDS = PLACE_FIELDS.split(",").map((field) => `places.${field}`).join(",");
const monas = { address: "Monas, Jakarta" };
const bundaran = { location: { latLng: { latitude: -6.195, longitude: 106.823 } } };

describeRestPluginContract(restDefinition, {
  operations: {
    search_text: {
      args: { text_query: "coffee near Monas", open_now: true, min_rating: 4, language_code: "id", limit: 5 },
      request: { method: "POST", url: `${PLACES}/places:searchText`, query: "absent", json: { textQuery: "coffee near Monas", openNow: true, minRating: 4, languageCode: "id", pageSize: 5 } },
      response: { body: { places: [{ id: "p1", displayName: { text: "Kopi" } }], nextPageToken: "t2" } },
      expect: { data: [{ id: "p1", displayName: { text: "Kopi" } }] },
    },
    search_nearby: {
      args: { latitude: -6.1754, longitude: 106.8272, radius_meters: 500, included_types: ["cafe"], rank_preference: "DISTANCE" },
      request: {
        method: "POST",
        url: `${PLACES}/places:searchNearby`,
        query: "absent",
        json: { locationRestriction: { circle: { center: { latitude: -6.1754, longitude: 106.8272 }, radius: 500 } }, includedTypes: ["cafe"], rankPreference: "DISTANCE" },
      },
    },
    get_place: {
      args: { place_id: "ChIJ123", language_code: "en", field_mask: `${PLACE_FIELDS},rating` },
      request: { method: "GET", url: `${PLACES}/places/ChIJ123`, query: { languageCode: "en" } },
    },
    autocomplete_places: {
      args: { input: "Grand Indon", included_region_codes: ["id"], session_token: "s-1" },
      request: { method: "POST", url: `${PLACES}/places:autocomplete`, query: "absent", json: { input: "Grand Indon", includedRegionCodes: ["id"], sessionToken: "s-1" } },
    },
    get_place_photo: {
      args: { photo_name: "places/ChIJ123/photos/Aap9", max_width_px: 400 },
      request: { method: "GET", url: `${PLACES}/places/ChIJ123/photos/Aap9/media`, query: { maxWidthPx: "400", skipHttpRedirect: "true" } },
      response: { body: { name: "places/ChIJ123/photos/Aap9/media", photoUri: "https://lh3.googleusercontent.com/p/x" } },
      expect: { data: { name: "places/ChIJ123/photos/Aap9/media", photoUri: "https://lh3.googleusercontent.com/p/x" } },
    },
    geocode_address: {
      args: { address: "Jl. M.H. Thamrin No.1, Jakarta", region_code: "ID" },
      request: { method: "GET", url: `${GEOCODE}/geocode/address`, query: { addressQuery: "Jl. M.H. Thamrin No.1, Jakarta", regionCode: "ID" } },
    },
    reverse_geocode: {
      args: { latitude: -6.1754, longitude: 106.8272, language_code: "id" },
      request: { method: "GET", url: `${GEOCODE}/geocode/location`, query: { "location.latitude": "-6.1754", "location.longitude": "106.8272", languageCode: "id" } },
    },
    compute_routes: {
      args: { origin: monas, destination: bundaran, route_modifiers: { avoidTolls: true } },
      request: { method: "POST", url: `${ROUTES}/directions/v2:computeRoutes`, query: "absent", json: { origin: monas, destination: bundaran, travelMode: "DRIVE", routeModifiers: { avoidTolls: true } } },
      response: { body: { routes: [{ distanceMeters: 3100, duration: "540s" }] } },
      expect: { data: [{ distanceMeters: 3100, duration: "540s" }] },
    },
    compute_route_matrix: {
      args: { origins: [{ waypoint: monas }], destinations: [{ waypoint: bundaran }], travel_mode: "TWO_WHEELER" },
      request: { method: "POST", url: `${ROUTES}/distanceMatrix/v2:computeRouteMatrix`, query: "absent", json: { origins: [{ waypoint: monas }], destinations: [{ waypoint: bundaran }], travelMode: "TWO_WHEELER" } },
      response: { body: [{ originIndex: 0, destinationIndex: 0, distanceMeters: 3100, duration: "600s", condition: "ROUTE_EXISTS" }] },
      expect: { data: [{ originIndex: 0, destinationIndex: 0, distanceMeters: 3100, duration: "600s", condition: "ROUTE_EXISTS" }] },
    },
  },
});

const KEY = "AIza-contract-0001";

async function runOperation(operationName, args, responses, { source = "tool", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_MAPS_API_KEY: KEY, ...environment }, { fetchImpl: recordingFetch });
  return { result: await run(operationName, args, { source }), calls: recordingFetch.calls };
}

test("every billed call sends a field mask by default (cheap fields) and the key as X-Goog-Api-Key", async () => {
  const { calls } = await runOperation("search_nearby", { latitude: 0, longitude: 0, radius_meters: 10 }, [{ body: { places: [] } }]);
  assert.equal(calls[0].headers["x-goog-fieldmask"], NEARBY_FIELDS);
  assert.equal(calls[0].headers["x-goog-api-key"], KEY);
  assert.equal(new URL(calls[0].url).searchParams.has("key"), false);
  const { calls: placeCalls } = await runOperation("get_place", { place_id: "p" }, [{ body: {} }]);
  assert.equal(placeCalls[0].headers["x-goog-fieldmask"], PLACE_FIELDS);
  const { calls: searchCalls } = await runOperation("search_text", { text_query: "x" }, [{ body: {} }]);
  assert.ok(searchCalls[0].headers["x-goog-fieldmask"].endsWith(",nextPageToken"));
});

test("search_text pages with nextPageToken in the body", async () => {
  const { result } = await runOperation("search_text", { text_query: "x" }, [{ body: { places: [{ id: "a" }], nextPageToken: "page-2" } }]);
  assert.ok(result.next_cursor);
  const { calls } = await runOperation("search_text", { text_query: "x", cursor: result.next_cursor }, [{ body: { places: [] } }]);
  assert.equal(JSON.parse(calls[0].body).pageToken, "page-2");
});

test("an invalid key (400 API_KEY_INVALID) is an auth_error", async () => {
  const body = { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } };
  await assert.rejects(runOperation("geocode_address", { address: "x" }, [{ status: 400, body }]), (error) => error.kind === "auth_error" && error.message.includes("API key not valid"));
});

test("a disabled API (403 SERVICE_DISABLED) is permission_denied", async () => {
  const body = { error: { code: 403, message: "Routes API has not been used in project 1", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } };
  await assert.rejects(runOperation("compute_routes", { origin: monas, destination: bundaran }, [{ status: 403, body }]), (error) => error.kind === "permission_denied");
});

test("agent route matrices are limited to 100 elements by default; nodes are not", async () => {
  const waypoints = (count) => Array.from({ length: count }, () => ({ waypoint: monas }));
  const tooLarge = { origins: waypoints(11), destinations: waypoints(10) };
  await assert.rejects(runOperation("compute_route_matrix", tooLarge, []), (error) => error.kind === "permission_denied" && error.message.includes("110"));
  const { calls } = await runOperation("compute_route_matrix", tooLarge, [{ body: [] }], { source: "node" });
  assert.equal(calls.length, 1);
  const { calls: raisedCalls } = await runOperation("compute_route_matrix", tooLarge, [{ body: [] }], { environment: { GOOGLE_MAPS_TOOL_MAX_MATRIX_ELEMENTS: "200" } });
  assert.equal(raisedCalls.length, 1);
});

test("agent field masks are limited to Essentials/Pro fields unless GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS=1", async () => {
  const refused = [
    ["get_place", { place_id: "p", field_mask: "*" }],
    ["get_place", { place_id: "p", field_mask: "id,reviews" }],
    ["get_place", { place_id: "p", field_mask: "id,rating" }],
    ["get_place", { place_id: "p", field_mask: "photos" }],
    ["search_text", { text_query: "x", field_mask: "places.id,places.editorialSummary" }],
    ["search_text", { text_query: "x", field_mask: "places" }],
    ["search_text", { text_query: "x", field_mask: "places.*" }],
    ["search_nearby", { latitude: 0, longitude: 0, radius_meters: 10, field_mask: "places.id,places.currentOpeningHours" }],
  ];
  for (const [operationName, args] of refused) {
    await assert.rejects(runOperation(operationName, args, []), (error) => error.kind === "permission_denied" && error.message.includes("GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS"), args.field_mask);
  }
  const { calls: allowedCalls } = await runOperation("search_text", { text_query: "x", field_mask: "places.id, places.displayName.text,places.location,nextPageToken" }, [{ body: {} }]);
  assert.equal(allowedCalls.length, 1);
  const { calls: optedInCalls } = await runOperation("get_place", { place_id: "p", field_mask: "*" }, [{ body: {} }], { environment: { GOOGLE_MAPS_TOOL_ALLOW_EXPENSIVE_FIELDS: "1" } });
  assert.equal(optedInCalls[0].headers["x-goog-fieldmask"], "*");
  const { calls: nodeCalls } = await runOperation("get_place", { place_id: "p", field_mask: "id,rating,reviews" }, [{ body: {} }], { source: "node" });
  assert.equal(nodeCalls.length, 1);
});

test("get_place_photo only takes a places/<id>/photos/<id> name", async () => {
  for (const photoName of ["places/p1", "places/p1/photos/a/b", "media/x/photos/y", "places//photos/y", "places/p1/photos/"]) {
    await assert.rejects(runOperation("get_place_photo", { photo_name: photoName }, []), (error) => error.kind === "invalid_input", photoName);
  }
  const { calls } = await runOperation("get_place_photo", { photo_name: "places/ChIJ1/photos/Aap-9_x" }, [{ body: { photoUri: "https://lh3.googleusercontent.com/p" } }], { source: "node" });
  assert.equal(new URL(calls[0].url).pathname, "/v1/places/ChIJ1/photos/Aap-9_x/media");
});
