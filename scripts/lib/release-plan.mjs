/**
 * Pure planning for the GitHub side of a publish (publish-plugins.mjs runs the plans with gh): what to do with a
 * plugin or mirror release that may already exist, in which order the catalog assets are uploaded, and whether
 * the uploaded assets hold the bytes that were meant to be uploaded.
 *
 * Upload order of the catalog: icons and detail files first (every URL an index names resolves before the index
 * is live), then `index-v2.json` and `index.json` together, then `SHA256SUMS` last. GitHub has no atomic
 * multi-asset update, so a reader can still, for a few seconds, see one index updated and the other not yet,
 * or both indexes new while SHA256SUMS still lists the previous ones; readers that check SHA256SUMS should retry
 * on a mismatch.
 */
import { basename } from "node:path";

const SHA256_DIGEST_PREFIX = "sha256:";

/**
 * Orders the catalog upload into sequential batches (each batch is one `gh release upload`).
 *
 * @param catalogFiles - From writeCatalogFiles: `{indexPath, indexV2Path, sumsPath}` (object)
 * @param newAssetPaths - Icons and detail files the release does not have yet (string[])
 * @param batchSize - Largest number of new assets per batch (number, default 50)
 * @returns Paths per batch, in upload order (string[][])
 */
export function planCatalogUploadBatches(catalogFiles, newAssetPaths, batchSize = 50) {
  const batches = [];
  for (let start = 0; start < newAssetPaths.length; start += batchSize) batches.push(newAssetPaths.slice(start, start + batchSize));
  batches.push([catalogFiles.indexV2Path, catalogFiles.indexPath]);
  batches.push([catalogFiles.sumsPath]);
  return batches;
}

/**
 * Compares uploaded assets with the files that were uploaded, using GitHub's `digest` (assets without one are
 * not checked).
 *
 * @param uploadedPaths - Local files that were uploaded (string[])
 * @param releaseAssets - `assets` of `gh release view --json assets` after the upload (object[])
 * @param sha256OfPath - Returns the sha256 of a local file (function)
 * @returns Mismatch messages; empty when every digest that GitHub reports matches (string[])
 */
export function findUploadedDigestMismatches(uploadedPaths, releaseAssets, sha256OfPath) {
  const assetsByName = new Map(releaseAssets.map((asset) => [asset.name, asset]));
  const mismatches = [];
  for (const uploadedPath of uploadedPaths) {
    const asset = assetsByName.get(basename(uploadedPath));
    if (!asset) {
      mismatches.push(`${basename(uploadedPath)}: missing from the release after the upload`);
      continue;
    }
    if (!asset.digest?.startsWith(SHA256_DIGEST_PREFIX)) continue;
    const expectedSha256 = sha256OfPath(uploadedPath);
    const uploadedSha256 = asset.digest.slice(SHA256_DIGEST_PREFIX.length);
    if (uploadedSha256 !== expectedSha256) mismatches.push(`${asset.name}: uploaded sha256 ${uploadedSha256}, expected ${expectedSha256}`);
  }
  return mismatches;
}
