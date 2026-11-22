import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CATALOG_PUBLIC_KEY_PATH, DEFAULT_SIGNING_KEY_PATH, buildTrustedComment, resolveSigningKeyPath, signCatalogIndexes, verifyFileSignature,
} from "../lib/catalog-signing.mjs";
import { buildCatalogEntry, sha256Hex } from "../lib/plugin-package.mjs";
import { planCatalogUploadBatches } from "../lib/release-plan.mjs";
import { writeCatalogFiles } from "../pack-plugins.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const minisignAvailable = spawnSync("minisign", ["-v"], { encoding: "utf8" }).status === 0;
const skipWithoutMinisign = minisignAvailable ? false : "minisign is not installed";

/** A throwaway, unencrypted key pair in a temp directory (never the real catalog key). */
function createThrowawayKeyPair(directory, name = "throwaway") {
  const keyPath = join(directory, `${name}.key`);
  const publicKeyPath = join(directory, `${name}.pub`);
  const result = spawnSync("minisign", ["-G", "-W", "-p", publicKeyPath, "-s", keyPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, result.stderr);
  return { keyPath, publicKeyPath };
}

function releasedOfficialPlugin(pluginName) {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pluginName, "graphrt-plugin.json"), "utf8"));
  const released = { tarballName: `${pluginName}-${manifest.version}.tar.gz`, sha256: "a".repeat(64), sizeBytes: 1, manifest };
  return { ...released, catalogEntry: buildCatalogEntry(manifest, released) };
}

function withScratchDirectory(action) {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "catalog-signing-test-"));
  try {
    return action(scratchDirectory);
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

test("the committed public key is the catalog key", () => {
  assert.match(readFileSync(CATALOG_PUBLIC_KEY_PATH, "utf8"), /^untrusted comment: minisign public key CB1AEE339F05C2BD\nRWS9wgWfM\+4ayykVUw9LH3DOjwa\+g\/JFaREz3FWd\/U8GJaa6q4WrNd9c\n$/);
});

test("the key path comes from GRAPHRT_CATALOG_SIGNING_KEY, defaulting to ~/.graphrt/keys", () => {
  assert.equal(resolveSigningKeyPath({}), DEFAULT_SIGNING_KEY_PATH);
  assert.match(DEFAULT_SIGNING_KEY_PATH, /\.graphrt\/keys\/catalog-minisign\.key$/);
  assert.equal(resolveSigningKeyPath({ GRAPHRT_CATALOG_SIGNING_KEY: "/run/key" }), "/run/key");
});

test("signs both indexes, verifies them, and lists the signatures in SHA256SUMS", { skip: skipWithoutMinisign }, () => {
  withScratchDirectory((scratchDirectory) => {
    const { keyPath, publicKeyPath } = createThrowawayKeyPair(scratchDirectory);
    const catalogDirectory = join(scratchDirectory, "catalog");
    const signIndexes = (indexes) => signCatalogIndexes(indexes, { keyPath, publicKeyPath, log: () => {} });
    const catalogFiles = writeCatalogFiles(catalogDirectory, ["currency-rates", "open-meteo"].map(releasedOfficialPlugin), { signIndexes });
    assert.deepEqual(catalogFiles.signaturePaths.map((signaturePath) => basename(signaturePath)), ["index-v2.json.minisig", "index.json.minisig"]);
    for (const indexPath of [catalogFiles.indexV2Path, catalogFiles.indexPath]) {
      assert.doesNotThrow(() => verifyFileSignature(indexPath, { publicKeyPath }));
      const catalog = JSON.parse(readFileSync(indexPath, "utf8"));
      assert.match(readFileSync(`${indexPath}.minisig`, "utf8"), new RegExp(`trusted comment: ${buildTrustedComment(basename(indexPath), catalog)}\n`));
      assert.match(buildTrustedComment(basename(indexPath), catalog), new RegExp(`plugins=2 generated_at=${catalog.generated_at}$`));
    }
    const sums = readFileSync(catalogFiles.sumsPath, "utf8");
    for (const signaturePath of catalogFiles.signaturePaths) assert.ok(sums.includes(`${sha256Hex(readFileSync(signaturePath))}  ${basename(signaturePath)}\n`));
    appendFileSync(catalogFiles.indexPath, " ");
    assert.throws(() => verifyFileSignature(catalogFiles.indexPath, { publicKeyPath }), /verifying .*index.json.minisig .* failed/);
  });
});

test("refuses signatures that the committed public key does not verify, before anything is uploaded", { skip: skipWithoutMinisign }, () => {
  withScratchDirectory((scratchDirectory) => {
    const { keyPath } = createThrowawayKeyPair(scratchDirectory, "signer");
    const { publicKeyPath: otherPublicKeyPath } = createThrowawayKeyPair(scratchDirectory, "other");
    const catalogDirectory = join(scratchDirectory, "catalog");
    const signIndexes = (indexes) => signCatalogIndexes(indexes, { keyPath, publicKeyPath: otherPublicKeyPath, log: () => {} });
    assert.throws(() => writeCatalogFiles(catalogDirectory, [releasedOfficialPlugin("currency-rates")], { signIndexes }), /verifying .* failed/);
  });
});

test("a real publish refuses an unsigned catalog without a key; a dry run warns", () => {
  withScratchDirectory((scratchDirectory) => {
    const missingKeyPath = join(scratchDirectory, "missing.key");
    const indexes = [{ path: join(scratchDirectory, "index.json"), name: "index.json", catalog: { plugins: [], generated_at: "x" } }];
    assert.throws(() => signCatalogIndexes(indexes, { keyPath: missingKeyPath, log: () => {} }), /no catalog signing key at .*missing.key \(set GRAPHRT_CATALOG_SIGNING_KEY\); refusing to publish an unsigned catalog/);
    const logLines = [];
    assert.deepEqual(signCatalogIndexes(indexes, { keyPath: missingKeyPath, dryRun: true, log: (line) => logLines.push(line) }), []);
    assert.match(logLines.join("\n"), /warning: no catalog signing key .* unsigned catalog/);
  });
});

test("uploads the signatures in the batch right before their indexes, and SHA256SUMS last", () => {
  const catalogFiles = {
    indexPath: "/c/index.json", indexV2Path: "/c/index-v2.json", sumsPath: "/c/SHA256SUMS", signaturePaths: ["/c/index-v2.json.minisig", "/c/index.json.minisig"],
  };
  assert.deepEqual(planCatalogUploadBatches(catalogFiles, ["/c/icons/a.svg"]), [
    ["/c/icons/a.svg"],
    ["/c/index-v2.json.minisig", "/c/index.json.minisig"],
    ["/c/index-v2.json", "/c/index.json"],
    ["/c/SHA256SUMS"],
  ]);
  assert.ok(!existsSync("/c"), "plain paths only");
});
