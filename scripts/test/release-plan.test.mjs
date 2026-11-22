import { test } from "node:test";
import assert from "node:assert/strict";
import { findUploadedDigestMismatches, planCatalogUploadBatches, planReleaseAction } from "../lib/release-plan.mjs";

test("a release without its asset is resumed by uploading the asset, never refused", () => {
  assert.equal(planReleaseAction(null, "demo-1.0.0.tar.gz"), "create");
  assert.equal(planReleaseAction({ assets: [] }, "demo-1.0.0.tar.gz"), "upload");
  assert.equal(planReleaseAction({ assets: [{ name: "other.txt" }] }, "demo-1.0.0.tar.gz"), "upload");
  assert.equal(planReleaseAction({ assets: [{ name: "demo-1.0.0.tar.gz" }] }, "demo-1.0.0.tar.gz"), "exists");
});

test("uploads new icons and details first, then both indexes together, then SHA256SUMS last", () => {
  const catalogFiles = { indexPath: "/c/index.json", indexV2Path: "/c/index-v2.json", sumsPath: "/c/SHA256SUMS" };
  const newAssets = ["/c/icons/a.svg", "/c/icons/b.svg", "/c/details/plugin-a-1.json"];
  assert.deepEqual(planCatalogUploadBatches(catalogFiles, newAssets, 2), [
    ["/c/icons/a.svg", "/c/icons/b.svg"],
    ["/c/details/plugin-a-1.json"],
    ["/c/index-v2.json", "/c/index.json"],
    ["/c/SHA256SUMS"],
  ]);
  assert.deepEqual(planCatalogUploadBatches(catalogFiles, []), [["/c/index-v2.json", "/c/index.json"], ["/c/SHA256SUMS"]]);
});

test("reports uploaded assets whose GitHub digest differs from the local file, or that are missing", () => {
  const sha256OfPath = (filePath) => (filePath.endsWith("index.json") ? "a".repeat(64) : "b".repeat(64));
  const assets = [
    { name: "index.json", digest: `sha256:${"a".repeat(64)}` },
    { name: "index-v2.json", digest: `sha256:${"c".repeat(64)}` },
    { name: "SHA256SUMS" },
  ];
  assert.deepEqual(findUploadedDigestMismatches(["/c/index.json", "/c/index-v2.json", "/c/SHA256SUMS", "/c/icon.svg"], assets, sha256OfPath), [
    `index-v2.json: uploaded sha256 ${"c".repeat(64)}, expected ${"b".repeat(64)}`,
    "icon.svg: missing from the release after the upload",
  ]);
});
