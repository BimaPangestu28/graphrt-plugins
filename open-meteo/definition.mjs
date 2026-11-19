/**
 * open-meteo plugin definition: weather forecasts and place search through the free Open-Meteo API
 * (https://open-meteo.com/en/docs). No API key. Built with the declarative REST layer, and the reference
 * plugin for it (docs/declarative-plugins.md).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const DEFAULT_CURRENT_VARIABLES = ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "precipitation", "weather_code", "wind_speed_10m"];
const DEFAULT_DAILY_VARIABLES = ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max"];
const variableList = (description, defaultVariables) => ({
  in: "query",
  type: "array",
  items: { type: "string" },
  maxItems: 50,
  description,
  ...(defaultVariables ? { default: defaultVariables } : {}),
});

const getForecast = {
  name: "get_forecast",
  title: "Weather forecast",
  description:
    "Weather forecast for a coordinate: current conditions, hourly and daily values for up to 16 days (WMO weather codes; units in *_units)",
  path: "/v1/forecast",
  params: {
    latitude: { in: "query", type: "number", required: true, min: -90, max: 90, description: "Latitude in degrees (WGS84)" },
    longitude: { in: "query", type: "number", required: true, min: -180, max: 180, description: "Longitude in degrees (WGS84)" },
    current: variableList("Current-condition variables, e.g. temperature_2m, weather_code, wind_speed_10m", DEFAULT_CURRENT_VARIABLES),
    hourly: variableList("Hourly variables, e.g. temperature_2m, precipitation_probability, cloud_cover (none by default)"),
    daily: variableList("Daily variables, e.g. temperature_2m_max, precipitation_sum, sunrise, uv_index_max", DEFAULT_DAILY_VARIABLES),
    timezone: { in: "query", type: "string", default: "auto", description: 'IANA time zone for times and daily boundaries, or "auto" for the location\'s own' },
    forecast_days: { in: "query", type: "integer", min: 1, max: 16, default: 7, description: "Days to forecast, including today" },
    past_days: { in: "query", type: "integer", min: 0, max: 92, description: "Also return this many past days" },
    temperature_unit: { in: "query", type: "string", enum: ["celsius", "fahrenheit"], description: "Default celsius" },
    wind_speed_unit: { in: "query", type: "string", enum: ["kmh", "ms", "mph", "kn"], description: "Default kmh" },
    precipitation_unit: { in: "query", type: "string", enum: ["mm", "inch"], description: "Default mm" },
  },
};

const searchLocations = {
  name: "search_locations",
  title: "Search places",
  description: "Find places by name (city, town or postal code) to get their coordinates, time zone, country and population; null when nothing matches",
  // Geocoding is served from its own host.
  baseUrl: "https://geocoding-api.open-meteo.com",
  path: "/v1/search",
  params: {
    name: { in: "query", type: "string", required: true, minLength: 2, description: "Place name or postal code, e.g. Bandung" },
    count: { in: "query", type: "integer", min: 1, max: 100, default: 10, description: "Maximum results" },
    language: { in: "query", type: "string", default: "en", description: "Language of the names, e.g. en, id, de" },
    country_code: { in: "query", type: "string", wireName: "countryCode", description: "Only places in this ISO 3166-1 alpha-2 country, e.g. ID" },
  },
  response: { dataPath: "results" },
};

export const pluginDefinition = defineRestPlugin({
  name: "open-meteo",
  version: "0.1.0",
  description: "Open-Meteo weather (no API key): forecasts with current, hourly and daily values, and place search for coordinates",
  apiName: "Open-Meteo forecast API",
  baseUrl: "https://api.open-meteo.com",
  auth: { type: "none" },
  // Errors are 400 {"error": true, "reason": "..."}; errorPath also catches the same shape in a 200.
  errors: { messagePath: "reason", errorPath: "error" },
  apiRequest: { examplePath: "/v1/forecast" },
  operations: [getForecast, searchLocations],
});
