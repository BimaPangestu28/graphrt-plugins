/**
 * Pure planning for the GitHub side of a publish (publish-plugins.mjs runs the plans with gh): what to do with a
 * plugin or mirror release that may already exist, in which order the catalog assets are uploaded, and whether
 * the uploaded assets hold the bytes that were meant to be uploaded.
 *
 * Upload order of the catalog: icons and detail files first (every URL an index names resolves before the index
 * is live), then the index signatures (`index-v2.json.minisig`, `index.json.minisig`), then `index-v2.json` and
 * `index.json` together, then `SHA256SUMS` last. GitHub has no atomic multi-asset update, so a reader can still,
 * for a few seconds, see one index updated and the other not yet, an OLD index next to its NEW signature (it
 * fails verification: retry), or both indexes new while SHA256SUMS still lists the previous ones; readers that
 * check a signature or SHA256SUMS should fetch again on a mismatch. Signatures go first so that a new index is
 * never served with an old signature once the index upload has finished.
 */
import { basename } from "node:path";

const SHA256_DIGEST_PREFIX = "sha256:";

/**
 * Decides what to do with a release that should hold one asset.
 *
 * @param existingRelease - `gh release view --json assets` output, or null when there is no release (object|null)
 * @param assetName - The asset the release must hold (string)
 * @returns "create" (no release), "upload" (the release exists without the asset: a half-created release to
 *   resume) or "exists" (object)
 */
export function planReleaseAction(existingRelease, assetName) {
  if (!existingRelease) return "create";
  return existingRelease.assets.some((asset) => asset.name === assetName) ? "exists" : "upload";
}

/**
 * Orders the catalog upload into sequential batches (each batch is one `gh release upload`).
 *
 * @param catalogFiles - From writeCatalogFiles: `{indexPath, indexV2Path, sumsPath, signaturePaths?}` (object)
 * @param newAssetPaths - Icons and detail files the release does not have yet (string[])
 * @param batchSize - Largest number of new assets per batch (number, default 50)
 * @returns Paths per batch, in upload order (string[][])
 */
export function planCatalogUploadBatches(catalogFiles, newAssetPaths, batchSize = 50) {
  const batches = [];
  for (let start = 0; start < newAssetPaths.length; start += batchSize) batches.push(newAssetPaths.slice(start, start + batchSize));
  if (catalogFiles.signaturePaths?.length > 0) batches.push([...catalogFiles.signaturePaths]);
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

const NETWORK_ERROR_PATTERN = /timeout|connection reset|EOF|ECONNRESET|502|503|504/i;
const RELEASE_NOT_FOUND_PATTERN = /release not found/i;

/**
 * Whether a failed idempotent gh command is worth running again: a network failure, or "release not found" from
 * `gh release download`. The publish only downloads from releases it has just seen (`gh release view`), so that
 * answer is GitHub briefly failing to resolve an existing release (seen while a run downloaded every published
 * tarball right after creating a release), not a missing one. `gh release view` is not retried on it: there
 * "release not found" is the normal answer for a version that is not published yet.
 */
export function isRetryableGhFailure(ghArguments, stderr) {
  const errorText = String(stderr ?? "");
  if (NETWORK_ERROR_PATTERN.test(errorText)) return true;
  const isReleaseDownload = ghArguments[0] === "release" && ghArguments[1] === "download";
  return isReleaseDownload && RELEASE_NOT_FOUND_PATTERN.test(errorText);
}

/** Pause before retry number `attempt` (1-based) of a gh command: 2 s, then 4 s, ... */
export function ghRetryDelayMilliseconds(attempt) {
  return 2000 * 2 ** (attempt - 1);
}
