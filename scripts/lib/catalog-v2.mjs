/**
 * Catalog v2: a slim `index-v2.json` for plugin lists plus one immutable `plugin-<name>-<version>.json`
 * detail file per released plugin version, all assets of the `catalog` release.
 *
 * v1 `index.json` carries every node's `config_schema`, ~90% of its bytes, although a reader needs them
 * only when a plugin is opened, installed or used by the builder. v2 moves them into the detail files,
 * which the index links with `detail_url`, `detail_sha256` and `detail_size_bytes`.
 *
 * A detail file is derived only from the released manifest of its version, so its bytes are stable for
 * that version: it is never re-uploaded with different bytes (publishing refuses), and readers cache it
 * forever. Changing what a detail file holds, or how it is serialised, therefore needs a new plugin version
 * for every plugin, or a new schema with new asset names.
 *
 * Shared spec with graphrt-builder-desktop: "Plugin catalog v2" (catalog-v2-spec.md).
 */
import { CATALOG_TAG, buildCatalogNode, releaseAssetUrl, sha256Hex } from "./plugin-package.mjs";

export const CATALOG_V2_SCHEMA_VERSION = 2;
export const CATALOG_V2_INDEX_NAME = "index-v2.json";
/** Above this the publish logs a warning: the index is meant to stay well under 500 KB. */
export const CATALOG_V2_WARNING_BYTES = 1024 * 1024;
/** Largest `index-v2.json` the desktop app downloads; publishing refuses a bigger one. */
export const MAX_CATALOG_V2_BYTES = 4 * 1024 * 1024;
/** Largest detail file the desktop app downloads; publishing refuses a bigger one. */
export const MAX_PLUGIN_DETAIL_BYTES = 1024 * 1024;
/** GitHub's limit of assets per release; the `catalog` release keeps old icons and detail files. */
export const MAX_RELEASE_ASSETS = 1000;
/** Asset count of the `catalog` release from which publishing warns that it needs pruning. */
export const RELEASE_ASSETS_WARNING_COUNT = 900;

/** @returns Asset name of a plugin version's detail file, e.g. `plugin-meta-api-0.1.0.json` (string) */
export function pluginDetailAssetName(pluginName, pluginVersion) {
  return `plugin-${pluginName}-${pluginVersion}.json`;
}

/**
 * Builds the detail document of one plugin version from its released manifest.
 *
 * @param releasedManifest - The manifest inside the published tarball (object)
 * @returns `{schema, name, version, nodes, tools}`; nodes as in v1 (`config_schema`, `outputs` when declared),
 *   tools as `{name, description}` (object)
 */
export function buildPluginDetail(releasedManifest) {
  return {
    schema: CATALOG_V2_SCHEMA_VERSION,
    name: releasedManifest.name,
    version: releasedManifest.version,
    nodes: (releasedManifest.nodes ?? []).map((manifestNode) => buildCatalogNode(manifestNode)),
    tools: (releasedManifest.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
  };
}

/**
 * Serialises a detail file as compact JSON and describes its bytes.
 *
 * @param pluginDetail - Detail from buildPluginDetail (object)
 * @returns `{assetName, bytes, sha256, sizeBytes}` (object)
 * @throws Error - When the file is larger than MAX_PLUGIN_DETAIL_BYTES
 */
export function renderPluginDetail(pluginDetail) {
  const assetName = pluginDetailAssetName(pluginDetail.name, pluginDetail.version);
  const bytes = Buffer.from(`${JSON.stringify(pluginDetail)}\n`);
  if (bytes.length > MAX_PLUGIN_DETAIL_BYTES) {
    throw new Error(`${assetName} is ${bytes.length} bytes; the desktop app accepts at most ${MAX_PLUGIN_DETAIL_BYTES}`);
  }
  return { assetName, bytes, sha256: sha256Hex(bytes), sizeBytes: bytes.length };
}

/**
 * Turns a v1 catalog entry into a v2 index entry: nodes become `node_kinds` (kind and title only) and the
 * entry links its detail file.
 *
 * @param catalogEntry - Entry from buildCatalogEntry (object)
 * @param renderedDetail - The entry's detail file from renderPluginDetail (object)
 * @returns A `plugins[]` entry of `index-v2.json` (object)
 * @throws Error - When the detail file belongs to another plugin version
 */
export function buildCatalogV2Entry(catalogEntry, renderedDetail) {
  const { nodes, readme_url: readmeUrl, ...listFields } = catalogEntry;
  if (renderedDetail.assetName !== pluginDetailAssetName(catalogEntry.name, catalogEntry.version)) {
    throw new Error(`${catalogEntry.name} ${catalogEntry.version}: detail file ${renderedDetail.assetName} belongs to another version`);
  }
  return {
    ...listFields,
    node_kinds: nodes.map(({ kind, title }) => ({ kind, title })),
    readme_url: readmeUrl,
    detail_url: releaseAssetUrl(CATALOG_TAG, renderedDetail.assetName),
    detail_sha256: renderedDetail.sha256,
    detail_size_bytes: renderedDetail.sizeBytes,
  };
}

/**
 * Builds the `index-v2.json` document.
 *
 * @param catalogV2Entries - Entries from buildCatalogV2Entry (object[])
 * @param generatedAt - Generation time (Date)
 * @returns The v2 catalog, plugins sorted by name (object)
 */
export function buildCatalogV2(catalogV2Entries, generatedAt) {
  return {
    schema: CATALOG_V2_SCHEMA_VERSION,
    generated_at: generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    plugins: [...catalogV2Entries].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Serialises `index-v2.json` as compact JSON and checks its size.
 *
 * @param catalogV2 - Catalog from buildCatalogV2 (object)
 * @returns `{catalogText, sizeBytes, warning}`; warning is a message above CATALOG_V2_WARNING_BYTES, else null (object)
 * @throws Error - When the text is larger than MAX_CATALOG_V2_BYTES
 */
export function renderCatalogV2Text(catalogV2) {
  const catalogText = `${JSON.stringify(catalogV2)}\n`;
  const sizeBytes = Buffer.byteLength(catalogText);
  if (sizeBytes > MAX_CATALOG_V2_BYTES) {
    throw new Error(`${CATALOG_V2_INDEX_NAME} is ${sizeBytes} bytes; the desktop app accepts at most ${MAX_CATALOG_V2_BYTES}. Raise its limit (and this one) first`);
  }
  const warning = sizeBytes > CATALOG_V2_WARNING_BYTES
    ? `${CATALOG_V2_INDEX_NAME} is ${sizeBytes} bytes (warning above ${CATALOG_V2_WARNING_BYTES}); move more fields into the detail files`
    : null;
  return { catalogText, sizeBytes, warning };
}

/**
 * Compares the detail files to publish with the `catalog` release assets of the same names. Detail files
 * are immutable: one that is already published must have exactly the expected bytes.
 *
 * @param stagedDetails - `{assetName, sha256}` per detail file to publish (object[])
 * @param publishedSha256ByName - sha256 of each published detail asset by name (Map<string, string>)
 * @returns `{newDetails, conflicts}`: the details not published yet, and one message per published asset
 *   whose sha256 differs (object)
 */
export function planDetailUploads(stagedDetails, publishedSha256ByName) {
  const newDetails = [];
  const conflicts = [];
  for (const stagedDetail of stagedDetails) {
    const publishedSha256 = publishedSha256ByName.get(stagedDetail.assetName);
    if (publishedSha256 === undefined) newDetails.push(stagedDetail);
    else if (publishedSha256 !== stagedDetail.sha256) {
      conflicts.push(`${stagedDetail.assetName}: published sha256 ${publishedSha256}, rebuilt ${stagedDetail.sha256}`);
    }
  }
  return { newDetails, conflicts };
}

/**
 * Formats the error for detail files that would change bytes under an existing name.
 *
 * @param conflicts - Messages from planDetailUploads (string[])
 * @returns The error to throw (Error)
 */
export function detailConflictError(conflicts) {
  return new Error([
    `refusing to publish: ${conflicts.length} detail file(s) on the ${CATALOG_TAG} release are immutable but would change:`,
    ...conflicts.map((conflict) => `  ${conflict}`),
    "A detail file is derived from the released manifest only; if its format changed, bump the plugin versions (or the v2 schema) instead of replacing it.",
  ].join("\n"));
}
