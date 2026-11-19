/**
 * wilayah-indonesia plugin definition: Indonesian administrative regions with Kemendagri codes (provinces →
 * regencies/cities → districts → villages), lookups with the parent chain, and name search.
 *
 * Data: db/wilayah.sql of github.com/cahyadsn/wilayah (MIT; Kepmendagri No 300.2.2-2138 Tahun 2025 with the
 * maintainer's later corrections), fetched once from raw.githubusercontent.com at a pinned commit and kept in memory
 * (and optionally on disk), see lib/dataset-loader.mjs. No public API offers name search over the current decree,
 * so this plugin is hand-written on the shared runner instead of the declarative REST layer: every operation is a
 * lookup in the parsed dataset.
 *
 * No credentials. Every operation is a read and an agent tool.
 */
import { createApiClient } from "./lib/shared/api-client.mjs";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import {
  CACHE_DIR_ENV,
  CACHE_TTL_ENV,
  createDatasetLoader,
  DATA_REF_ENV,
  DATA_SHA256_ENV,
  DATASET_HOST,
  MAX_DATASET_BYTES,
  readBodyWithinLimit,
  readDatasetSettings,
} from "./lib/dataset-loader.mjs";
import { describeRegion, LEVELS, levelOfCode, listParents, normalizeRegionCode, searchRegions } from "./lib/region-index.mjs";

// Three attempts (two retries with backoff) must fit in limits.timeout_ms (90 s).
const DOWNLOAD_TIMEOUT_MS = 25000;
const codeParameter = (description) => ({ type: "string", minLength: 2, description });
const childListOperation = (loadIndexFor, { name, title, description, parameterName, parentLevel, parameterDescription }) => ({
  name,
  title,
  description,
  parameters: { type: "object", properties: { [parameterName]: codeParameter(parameterDescription) }, required: [parameterName] },
  run: async (context) => {
    const regionIndex = await loadIndexFor(context);
    const parent = requireRegion(regionIndex, context.args[parameterName], parameterName, parentLevel);
    return { data: listChildren(regionIndex, parent) };
  },
});

function listChildren(regionIndex, parentCode) {
  return (regionIndex.childrenByParent.get(parentCode) ?? []).map((code) => describeRegion(regionIndex, code));
}

function requireRegion(regionIndex, rawCode, parameterName, expectedLevel) {
  const code = normalizeRegionCode(rawCode, parameterName);
  if (expectedLevel && levelOfCode(code) !== expectedLevel) {
    throw new PluginError(`\`${parameterName}\` must be a ${expectedLevel} code; ${code} is a ${levelOfCode(code)} code`, { kind: "invalid_input" });
  }
  if (!regionIndex.namesByCode.has(code)) throw new PluginError(`No region with Kemendagri code ${code}`, { kind: "not_found" });
  return code;
}

function formatAddress(regionIndex, code) {
  return [describeRegion(regionIndex, code), ...listParents(regionIndex, code).reverse()].map((region) => region.name).join(", ");
}

const listProvinces = (loadIndexFor) => ({
  name: "list_provinces",
  title: "List provinces",
  description: "All 38 provinces of Indonesia with their 2-digit Kemendagri codes",
  parameters: { type: "object", properties: {}, required: [] },
  run: async (context) => ({ data: listChildren(await loadIndexFor(context), "") }),
});

const getRegion = (loadIndexFor) => ({
  name: "get_region",
  title: "Get region",
  description: "One region by Kemendagri code (dots optional, e.g. 32.73.07.1001 or 3273071001): name, level, village type (desa/kelurahan), parents and full address",
  parameters: { type: "object", properties: { code: codeParameter("Kemendagri code of a province, regency/city, district or village") }, required: ["code"] },
  run: async (context) => {
    const regionIndex = await loadIndexFor(context);
    const code = requireRegion(regionIndex, context.args.code, "code");
    const childCount = regionIndex.childrenByParent.get(code)?.length ?? 0;
    return { data: { ...describeRegion(regionIndex, code), parents: listParents(regionIndex, code), address: formatAddress(regionIndex, code), child_count: childCount } };
  },
});

const searchRegionsOperation = (loadIndexFor) => ({
  name: "search_regions",
  title: "Search regions",
  description: "Find provinces, regencies/cities, districts or villages by name (case and accent insensitive, every word must match), best matches first, with full addresses",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2, description: 'One region name or part of it, e.g. "coblong" or "kota bandung" (narrow with level and within_code)' },
      level: { type: "string", enum: LEVELS, description: "Only this level" },
      within_code: codeParameter("Only regions under this code, e.g. 32 (Jawa Barat) or 32.73 (Kota Bandung)"),
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Maximum results" },
    },
    required: ["query"],
  },
  run: async (context) => {
    const regionIndex = await loadIndexFor(context);
    const { query, level, within_code: rawWithinCode, limit } = context.args;
    const withinCode = rawWithinCode === undefined ? undefined : requireRegion(regionIndex, rawWithinCode, "within_code");
    const { matches, total } = searchRegions(regionIndex, { query, level, withinCode, limit });
    const regions = matches.map(({ code }) => ({ ...describeRegion(regionIndex, code), address: formatAddress(regionIndex, code) }));
    return { data: { regions, total_matches: total } };
  },
});

const buildOperations = (loadIndexFor) => [
  listProvinces(loadIndexFor),
  childListOperation(loadIndexFor, { name: "list_regencies", title: "List regencies and cities", description: "Regencies (kabupaten) and cities (kota) of a province", parameterName: "province_code", parentLevel: "province", parameterDescription: "2-digit province code, e.g. 32" }),
  childListOperation(loadIndexFor, { name: "list_districts", title: "List districts", description: "Districts (kecamatan) of a regency or city", parameterName: "regency_code", parentLevel: "regency", parameterDescription: "Regency/city code, e.g. 32.73 or 3273" }),
  childListOperation(loadIndexFor, { name: "list_villages", title: "List villages", description: "Villages of a district: desa and kelurahan (type) with their 10-digit codes", parameterName: "district_code", parentLevel: "district", parameterDescription: "District code, e.g. 32.73.07 or 327307" }),
  getRegion(loadIndexFor),
  searchRegionsOperation(loadIndexFor),
];

/**
 * Builds the plugin definition; each definition has its own in-memory dataset cache.
 *
 * @param definitionOptions - Options (object, optional)
 * @param definitionOptions.now - Clock in ms for cache expiry (function)
 * @returns Plugin definition for the shared runner (object)
 *
 * @example
 * const definition = createWilayahDefinition({ now: () => 0 });
 */
export function createWilayahDefinition({ now, pinnedSha256 } = {}) {
  const loadRegionIndex = createDatasetLoader({ now });
  const loadIndexFor = ({ client, environment, signal }) =>
    loadRegionIndex({ settings: readDatasetSettings(environment, { pinnedSha256 }), downloadDataset: client.downloadDataset, signal });
  return {
    name: "wilayah-indonesia",
    version: "0.1.0",
    description: "Indonesian administrative regions with Kemendagri codes: provinces, regencies/cities, districts and villages, lookups with full addresses, and name search (no API key)",
    noCredentials: true,
    extraEnv: [DATA_REF_ENV, DATA_SHA256_ENV, CACHE_DIR_ENV, CACHE_TTL_ENV],
    limits: { timeout_ms: 90000 },
    createClient: ({ fetchImpl }) => createDatasetClient(fetchImpl),
    operations: buildOperations(loadIndexFor),
  };
}

function createDatasetClient(fetchImpl) {
  const apiClient = createApiClient({ baseUrl: DATASET_HOST, timeoutMs: DOWNLOAD_TIMEOUT_MS, fetchImpl, defaultHeaders: { accept: "text/plain" } });
  return {
    // Raw response, read here with the size cap so a huge body is never buffered whole.
    downloadDataset: async (datasetPath, signal) => {
      const { response } = await apiClient.requestWithHeaders({ path: datasetPath, signal, rawResponse: true });
      try {
        return await readBodyWithinLimit(response, MAX_DATASET_BYTES);
      } catch (readError) {
        if (readError instanceof PluginError) throw readError;
        throw new PluginError(`Network error while reading the region dataset: ${readError?.message ?? readError}`, { kind: "network_error", retryable: true });
      }
    },
  };
}

export const pluginDefinition = createWilayahDefinition();
