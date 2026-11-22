/**
 * Signs the catalog indexes with minisign, so readers can check that `index-v2.json` and `index.json` were
 * published by this repo's maintainers, whatever served them.
 *
 * Each index gets a detached `<index>.minisig` next to it, whose trusted comment carries the plugin count and
 * `generated_at` (minisign signs the trusted comment too, so a reader can show them as verified). Before
 * anything is uploaded the signatures are verified with the public key committed at `catalog-signing.pub`, so
 * a publish with the wrong key fails here rather than in every reader.
 *
 * The secret key never enters the repo: its path comes from GRAPHRT_CATALOG_SIGNING_KEY (default
 * `~/.graphrt/keys/catalog-minisign.key`); in CI the release workflow writes it from a secret to a mode-600 temp
 * file. A real publish refuses to upload an unsigned catalog; a dry run signs when the key is there and
 * otherwise only warns. Key rotation: see docs (README "Catalog signature").
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../plugins.mjs";

export const SIGNING_KEY_VARIABLE = "GRAPHRT_CATALOG_SIGNING_KEY";
export const DEFAULT_SIGNING_KEY_PATH = join(homedir(), ".graphrt", "keys", "catalog-minisign.key");
export const CATALOG_PUBLIC_KEY_PATH = join(REPO_ROOT, "catalog-signing.pub");
export const SIGNATURE_SUFFIX = ".minisig";
const MINISIGN_TIMEOUT_MS = 30_000;

/**
 * The signing key path: GRAPHRT_CATALOG_SIGNING_KEY, else the default under ~/.graphrt/keys.
 *
 * @param environment - Variables (object, default process.env)
 * @returns The path (string)
 */
export function resolveSigningKeyPath(environment = process.env) {
  return environment[SIGNING_KEY_VARIABLE] || DEFAULT_SIGNING_KEY_PATH;
}

/**
 * The trusted comment of an index signature: what a reader may display as verified.
 *
 * @param indexName - `index-v2.json` or `index.json` (string)
 * @param catalog - The parsed index (object)
 * @returns The comment (string)
 */
export function buildTrustedComment(indexName, catalog) {
  return `graphrt-plugins ${indexName} plugins=${catalog.plugins.length} generated_at=${catalog.generated_at}`;
}

/**
 * Signs one file with minisign (`-S -s <key> -m <file> -x <file>.minisig -t <comment>`, an argument array).
 *
 * @param filePath - File to sign (string)
 * @param options - Signing options
 * @param options.keyPath - Unencrypted minisign secret key (string)
 * @param options.trustedComment - Signed comment (string)
 * @param options.minisignBinary - minisign executable (string, default "minisign")
 * @returns The signature path (string)
 * @throws Error - When minisign fails (its stderr, never the key, is in the message)
 */
export function signFile(filePath, { keyPath, trustedComment, minisignBinary = "minisign" }) {
  const signaturePath = `${filePath}${SIGNATURE_SUFFIX}`;
  const signArguments = ["-S", "-s", keyPath, "-m", filePath, "-x", signaturePath, "-t", trustedComment];
  runMinisign(minisignBinary, signArguments, `signing ${filePath}`);
  return signaturePath;
}

/**
 * Verifies a detached signature with a public key file.
 *
 * @param filePath - Signed file (string)
 * @param options - Verification options
 * @param options.publicKeyPath - minisign public key file (string, default: the committed catalog-signing.pub)
 * @param options.signaturePath - Signature (string, default `<file>.minisig`)
 * @param options.minisignBinary - minisign executable (string, default "minisign")
 * @throws Error - When the signature does not verify
 */
export function verifyFileSignature(filePath, { publicKeyPath = CATALOG_PUBLIC_KEY_PATH, signaturePath = `${filePath}${SIGNATURE_SUFFIX}`, minisignBinary = "minisign" } = {}) {
  runMinisign(minisignBinary, ["-V", "-q", "-p", publicKeyPath, "-m", filePath, "-x", signaturePath], `verifying ${signaturePath} with ${publicKeyPath}`);
}

/**
 * Signs the catalog indexes and verifies the signatures with the committed public key.
 *
 * @param indexes - `{path, name, catalog}` per index (object[])
 * @param options - Signing options
 * @param options.dryRun - Warn instead of refusing when there is no key (boolean, default false)
 * @param options.keyPath - Secret key (string, default resolveSigningKeyPath())
 * @param options.publicKeyPath - Public key to verify with (string, default CATALOG_PUBLIC_KEY_PATH)
 * @param options.minisignBinary - minisign executable (string, default "minisign")
 * @param options.log - Logs a line (function, default console.error)
 * @returns The signature paths, in the order of `indexes`; empty for a dry run without a key (string[])
 * @throws Error - Without a key on a real publish, or when signing or verification fails
 */
export function signCatalogIndexes(indexes, { dryRun = false, keyPath = resolveSigningKeyPath(), publicKeyPath = CATALOG_PUBLIC_KEY_PATH, minisignBinary = "minisign", log = console.error } = {}) {
  if (!existsSync(keyPath)) {
    const message = `no catalog signing key at ${keyPath} (set ${SIGNING_KEY_VARIABLE})`;
    if (!dryRun) throw new Error(`${message}; refusing to publish an unsigned catalog`);
    log(`warning: ${message}; this dry run writes an unsigned catalog`);
    return [];
  }
  const signaturePaths = indexes.map(({ path, name, catalog }) => signFile(path, { keyPath, trustedComment: buildTrustedComment(name, catalog), minisignBinary }));
  indexes.forEach(({ path }) => verifyFileSignature(path, { publicKeyPath, minisignBinary }));
  log(`catalog: signed ${indexes.map(({ name }) => name).join(" and ")}; verified with ${publicKeyPath}`);
  return signaturePaths;
}

function runMinisign(minisignBinary, minisignArguments, action) {
  const result = spawnSync(minisignBinary, minisignArguments, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: MINISIGN_TIMEOUT_MS });
  if (result.error) throw new Error(`${action} failed: ${result.error.code === "ENOENT" ? `${minisignBinary} is not installed` : result.error.message}`);
  if (result.status !== 0) throw new Error(`${action} failed: ${(result.stderr || result.stdout).trim()}`);
}
