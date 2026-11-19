/**
 * bmkg plugin definition: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika) open data, no API key
 * (https://data.bmkg.go.id): the latest earthquake, the last 15 M5.0+ and felt earthquakes, 3-day weather forecasts
 * per village (adm4 code), and nowcast weather warnings (RSS + CAP XML). Built with the declarative REST layer
 * (docs/declarative-plugins.md); lib/bmkg-results.mjs checks codes and shapes results, lib/nowcast-xml.mjs reads XML.
 *
 * Terms: BMKG must be credited as the data source wherever the data is shown; 60 requests per minute per IP.
 * Every operation is a read and an agent tool.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { addShakemapUrl, ADM4_PATTERN, ALERT_CODE_PATTERN, assertArgumentPattern, capResponseBodies, flattenForecast, shapeOperationResults } from "./lib/bmkg-results.mjs";
import { parseCapAlert, parseNowcastFeed } from "./lib/nowcast-xml.mjs";

const ATTRIBUTION = "Source: BMKG (Badan Meteorologi, Klimatologi, dan Geofisika); credit BMKG when showing it";
const XML_ACCEPT = { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.1" };
// A path param, so it is required (the layer refuses optional path params): "id" or "en".
const languageParam = { in: "path", type: "string", required: true, enum: ["id", "en"], description: "Warning text language: id (Indonesian) or en (English)" };

const earthquakeOperations = [
  {
    name: "get_latest_earthquake",
    title: "Latest earthquake",
    description: `The most recent earthquake BMKG reported in Indonesia: time (WIB and UTC DateTime), coordinates, magnitude, depth, region, tsunami potential, felt intensity (MMI) and shakemap_url. ${ATTRIBUTION}`,
    path: "/DataMKG/TEWS/autogempa.json",
    response: { dataPath: "Infogempa.gempa" },
  },
  {
    name: "list_recent_earthquakes",
    title: "Recent M5.0+ earthquakes",
    description: `The last 15 earthquakes of magnitude 5.0 or more in and around Indonesia, newest first, with tsunami potential. ${ATTRIBUTION}`,
    path: "/DataMKG/TEWS/gempaterkini.json",
    response: { dataPath: "Infogempa.gempa" },
  },
  {
    name: "list_felt_earthquakes",
    title: "Recent felt earthquakes",
    description: `The last 15 earthquakes people felt (any magnitude), newest first, with where and how strongly (MMI scale) they were felt. ${ATTRIBUTION}`,
    path: "/DataMKG/TEWS/gempadirasakan.json",
    response: { dataPath: "Infogempa.gempa" },
  },
];

const weatherOperations = [
  {
    name: "get_weather_forecast",
    title: "Village weather forecast",
    description:
      "3-day weather forecast for one village/kelurahan (Kemendagri adm4 code, e.g. 31.71.03.1001 Kemayoran) in 3-hour steps: " +
      `temperature t (°C), humidity hu (%), weather_desc/weather_desc_en, wind ws (km/h) and wd, cloud cover tcc (%), rain tp (mm), visibility vs_text, local_datetime. ${ATTRIBUTION}`,
    baseUrl: "https://api.bmkg.go.id",
    path: "/publik/prakiraan-cuaca",
    params: {
      adm4: { in: "query", type: "string", required: true, description: "Village (adm4) code from Kemendagri No. 100.1.1-6117/2022, e.g. 31.71.03.1001" },
    },
  },
  {
    name: "list_weather_warnings",
    title: "Active weather warnings",
    description: `Active nowcast weather warnings (heavy rain, thunderstorms, strong wind) per province, with each warning's alert_code for get_weather_warning. ${ATTRIBUTION}`,
    baseUrl: "https://www.bmkg.go.id",
    path: "/alerts/nowcast/{language}",
    params: { language: languageParam },
    constants: { headers: XML_ACCEPT },
  },
  {
    name: "get_weather_warning",
    title: "Weather warning details",
    description: `One nowcast warning (CAP): event, urgency, severity, certainty, effective/expires times, affected districts, infographic URL and optionally the area polygons. ${ATTRIBUTION}`,
    baseUrl: "https://www.bmkg.go.id",
    path: "/alerts/nowcast/{language}/{alert_code}_alert.xml",
    params: {
      language: languageParam,
      alert_code: { in: "path", type: "string", required: true, description: "alert_code from list_weather_warnings, e.g. CNB20261119001" },
    },
    constants: { headers: XML_ACCEPT },
  },
];

/** The declarative definition before argument checks, shaping and the body cap (used by the contract test). */
export const restDefinition = defineRestPlugin({
  name: "bmkg",
  version: "0.1.0",
  description: "BMKG open data (no API key): latest, M5.0+ and felt earthquakes, 3-day village weather forecasts by adm4 code, nowcast weather warnings (credit BMKG as the source)",
  apiName: "BMKG open data",
  baseUrl: "https://data.bmkg.go.id",
  auth: { type: "none" },
  // Weather API errors are {"error": "Data cuaca tidak ditemukan"} (404) or {"error": "Parameter adm tidak valid"} (400).
  errors: { messagePath: ["error", "message"] },
  apiRequest: { examplePath: "/DataMKG/TEWS/autogempa.json" },
  operations: [...earthquakeOperations, ...weatherOperations],
});

/** Argument checks and result shaping per operation (see shapeOperationResults). */
export const RESULT_SHAPERS = {
  get_latest_earthquake: { shapeData: addShakemapUrl },
  list_recent_earthquakes: { shapeData: (earthquakes) => (Array.isArray(earthquakes) ? earthquakes.map(addShakemapUrl) : earthquakes) },
  get_weather_forecast: {
    checkArgs: (args) => assertArgumentPattern("adm4", args.adm4, ADM4_PATTERN, "31.71.03.1001 (province.regency.district.village)"),
    shapeData: flattenForecast,
  },
  list_weather_warnings: { shapeData: (body) => parseNowcastFeed(body?.text) },
  get_weather_warning: {
    checkArgs: (args) => assertArgumentPattern("alert_code", args.alert_code, ALERT_CODE_PATTERN, "CNB20261119002 (letters and digits)"),
    // include_polygons only shapes our output; it is never sent to BMKG.
    extraParameters: { include_polygons: { type: "boolean", default: false, description: "Also return the area polygons as [latitude, longitude] pairs (large)" } },
    shapeData: (body, args) => parseCapAlert(body?.text, { includePolygons: args.include_polygons === true }),
  },
};

// Every body (earthquake JSON, forecasts, RSS/CAP XML, api_request) is read at most up to 2 MB before parsing.
export const pluginDefinition = capResponseBodies(shapeOperationResults(restDefinition, RESULT_SHAPERS));
