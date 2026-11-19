/**
 * libur-nasional plugin definition: Indonesian national holidays (libur nasional) and collective leave (cuti bersama)
 * from 2011 to next year. No API key.
 *
 * Source: there is no official government API. The official source is the yearly joint decree (SKB 3 Menteri:
 * Menteri Agama, Menteri Ketenagakerjaan, Menteri PANRB), published as PDF. The plugin reads the public JSON API of
 * the open-source api-hari-libur project (https://api-hari-libur.pages.dev, MIT, a maintained fork of
 * radyakaze/api-hari-libur; its data credits tanggalans.com). Checked against SKB No. 1497/2025, 2/2025 and 5/2025
 * for 2026: all 16 holidays and 8 cuti bersama days match. LIBUR_NASIONAL_API_URL points it at a self-hosted copy.
 *
 * Built with the declarative REST layer (one request: GET /api?year=YYYY); lib/holiday-operations.mjs caches each
 * year in memory and adds check_date, next_holidays and count_working_days. Every operation is a read and a tool.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createTtlCache } from "./lib/holiday-cache.mjs";
import { addHolidayOperations, CACHE_TTL_ENV } from "./lib/holiday-operations.mjs";

const DEFAULT_API_URL = "https://api-hari-libur.pages.dev";
const API_URL_ENV = "LIBUR_NASIONAL_API_URL";
const FIRST_YEAR = 2011;

const listHolidays = {
  name: "list_holidays",
  title: "List holidays",
  description:
    "Indonesian national holidays (libur nasional) and cuti bersama of a year (2011 to next year), optionally one month or kind; " +
    "each item has date, name, is_national_holiday and kind",
  path: "/api",
  params: {
    year: { in: "query", type: "integer", min: FIRST_YEAR, max: 2100, description: "Year (default: the current year in Asia/Jakarta)" },
  },
};

/**
 * Builds the plugin definition with its own holiday cache.
 *
 * @param options - `{cache, now}` for tests: a createTtlCache() instance and a millisecond clock (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition({ cache = createTtlCache(), now = Date.now } = {}) {
  const restDefinition = defineRestPlugin({
    name: "libur-nasional",
    version: "0.1.0",
    description: "Indonesian public holidays (libur nasional) and cuti bersama, 2011 to next year: list, check a date, upcoming holidays, working-day counts (no API key, cached)",
    apiName: "API Hari Libur",
    baseUrl: (environment) => (environment[API_URL_ENV]?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
    auth: { type: "none" },
    extraEnv: [API_URL_ENV, CACHE_TTL_ENV],
    // Validation errors are 422 {"error": true, "message": "The given data was invalid.", "data": {"year": ["Maximum year is 2027"]}}.
    errors: { messagePath: ["data.year.0", "data.month.0", "data.day.0", "message"], kindByStatus: { 422: "invalid_input" } },
    apiRequest: { examplePath: "/api/today" },
    operations: [listHolidays],
  });
  return addHolidayOperations(restDefinition, { cache, now });
}

export const pluginDefinition = createPluginDefinition();
