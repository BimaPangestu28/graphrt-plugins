/**
 * Loads the Kemendagri region dataset (db/wilayah.sql of github.com/cahyadsn/wilayah, MIT) once per process and
 * optionally keeps a copy on disk.
 *
 * - Source: https://raw.githubusercontent.com/cahyadsn/wilayah/<ref>/db/wilayah.sql. The default ref is a pinned
 *   commit, so results do not change under a workflow; WILAYAH_INDONESIA_DATA_REF picks another commit, tag or
 *   branch.
 * - Integrity: the pinned commit's file must have DEFAULT_DATA_SHA256. For another ref, WILAYAH_INDONESIA_DATA_SHA256
 *   gives the expected hash; without it that ref is not hash-checked (only the province-count check below). The hash
 *   is checked on every download and on every disk cache read; a mismatch is never cached or used.
 * - Size: the download is read as a stream and refused past MAX_DATASET_BYTES (or a larger Content-Length).
 * - Memory: one parsed index per ref, shared by all calls of the process (the runner builds a new client per call).
 *   Concurrent first calls share one download; a failed load is forgotten so the next call tries again.
 * - Disk (WILAYAH_INDONESIA_CACHE_DIR, absolute): `wilayah-<ref>.sql`. A commit SHA never changes, so its copy never
 *   expires; branches and tags are refreshed after WILAYAH_INDONESIA_CACHE_TTL_HOURS (default 24).
 * - A download is accepted only when it parses into at least MIN_PROVINCES provinces (an HTML error page or a
 *   truncated file is refused, and never cached).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { buildRegionIndex, levelOfCode, parseRegionSql } from "./region-index.mjs";

/** Last commit that changed db/wilayah.sql (2026-02-13), data per Kepmendagri No 300.2.2-2138 Tahun 2025. */
export const DEFAULT_DATA_REF = "d68e8d5516f969d1905d0b2940f20034becb0db7";
/** SHA-256 of db/wilayah.sql at DEFAULT_DATA_REF (2,947,579 bytes). */
export const DEFAULT_DATA_SHA256 = "c4c3396d9380d4edee072af1d9dff83573b574d7cd00a6562cf82e200e954031";
export const DATA_REF_ENV = "WILAYAH_INDONESIA_DATA_REF";
export const DATA_SHA256_ENV = "WILAYAH_INDONESIA_DATA_SHA256";
export const CACHE_DIR_ENV = "WILAYAH_INDONESIA_CACHE_DIR";
export const CACHE_TTL_ENV = "WILAYAH_INDONESIA_CACHE_TTL_HOURS";
export const DATASET_HOST = "https://raw.githubusercontent.com";
/** The pinned file is about 3 MB; anything past this is refused while streaming. */
export const MAX_DATASET_BYTES = 20 * 1024 * 1024;
const DEFAULT_TTL_HOURS = 24;
const MIN_PROVINCES = 30;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HOUR_MS = 3600 * 1000;

function resolveExpectedSha256(environment, ref, pinnedSha256) {
  const configured = environment[DATA_SHA256_ENV]?.trim().toLowerCase();
  if (configured && !SHA256_PATTERN.test(configured)) throw new PluginError(`${DATA_SHA256_ENV} must be 64 hex characters (the SHA-256 of wilayah.sql)`, { kind: "invalid_input" });
  return configured || (ref === DEFAULT_DATA_REF ? pinnedSha256 : undefined);
}

/**
 * Reads and validates the dataset settings from the environment.
 *
 * @param environment - Environment variables (object)
 * @param options - `{pinnedSha256}`: hash of the pinned file, for tests (object, default DEFAULT_DATA_SHA256)
 * @returns `{ref, datasetPath, cacheDirectory?, ttlMs, expectedSha256?}` (object)
 * @throws PluginError kind `invalid_input` - Bad ref, hash, relative cache directory or bad TTL
 */
export function readDatasetSettings(environment = {}, { pinnedSha256 = DEFAULT_DATA_SHA256 } = {}) {
  const ref = environment[DATA_REF_ENV]?.trim() || DEFAULT_DATA_REF;
  if (!REF_PATTERN.test(ref) || ref.includes("..")) throw new PluginError(`${DATA_REF_ENV} must be a commit SHA, tag or branch name of cahyadsn/wilayah`, { kind: "invalid_input" });
  const expectedSha256 = resolveExpectedSha256(environment, ref, pinnedSha256);
  const cacheDirectory = environment[CACHE_DIR_ENV]?.trim() || undefined;
  if (cacheDirectory && !isAbsolute(cacheDirectory)) throw new PluginError(`${CACHE_DIR_ENV} must be an absolute directory path`, { kind: "invalid_input" });
  const ttlText = environment[CACHE_TTL_ENV]?.trim();
  const ttlHours = ttlText ? Number(ttlText) : DEFAULT_TTL_HOURS;
  if (!Number.isFinite(ttlHours) || ttlHours < 0) throw new PluginError(`${CACHE_TTL_ENV} must be a number of hours >= 0`, { kind: "invalid_input" });
  const ttlMs = COMMIT_SHA_PATTERN.test(ref) ? Infinity : ttlHours * HOUR_MS;
  return { ref, datasetPath: `/cahyadsn/wilayah/${ref}/db/wilayah.sql`, cacheDirectory, ttlMs, expectedSha256 };
}

/**
 * Reads a response body as bytes, refusing it past `maxBytes` (declared or while streaming).
 *
 * @param response - A fetch Response (Response)
 * @param maxBytes - Size cap (number)
 * @returns The body (Buffer)
 * @throws PluginError kind `api_error` (not retryable) - The body is larger than maxBytes
 */
export async function readBodyWithinLimit(response, maxBytes) {
  const tooLarge = () => new PluginError(`The region dataset is larger than ${maxBytes} bytes; refused`, { kind: "api_error", retryable: false });
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, totalBytes);
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
}

/**
 * Creates a loader whose memory cache lives as long as the loader (one per process in the plugin).
 *
 * @param loaderOptions - Options (object, optional)
 * @param loaderOptions.now - Clock in ms (function, default Date.now)
 * @returns `loadRegionIndex({settings, downloadDataset, signal})` resolving to the index (function)
 *   (`downloadDataset(path, signal)` resolves to the file's bytes, a Buffer)
 */
export function createDatasetLoader({ now = Date.now } = {}) {
  const loadsByRef = new Map();
  return async function loadRegionIndex({ settings, downloadDataset, signal }) {
    const cached = loadsByRef.get(settings.ref);
    if (cached && now() - cached.startedAt < settings.ttlMs) return cached.promise;
    const promise = loadIndex({ settings, downloadDataset, signal, now });
    loadsByRef.set(settings.ref, { startedAt: now(), promise });
    promise.catch(() => {
      if (loadsByRef.get(settings.ref)?.promise === promise) loadsByRef.delete(settings.ref);
    });
    return promise;
  };
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasExpectedHash(settings, bytes) {
  return !settings.expectedSha256 || sha256Of(bytes) === settings.expectedSha256;
}

async function loadIndex({ settings, downloadDataset, signal, now }) {
  const cachedIndex = await loadFromDiskCache(settings, now);
  if (cachedIndex) return cachedIndex;
  const datasetUrl = `${DATASET_HOST}${settings.datasetPath}`;
  const datasetBytes = await downloadDataset(settings.datasetPath, signal);
  if (!Buffer.isBuffer(datasetBytes)) throw new PluginError(`The region dataset at ${datasetUrl} could not be read`, { kind: "api_error" });
  if (!hasExpectedHash(settings, datasetBytes)) {
    throw new PluginError(`The region dataset at ${datasetUrl} does not have the expected SHA-256 ${settings.expectedSha256}; refused`, { kind: "api_error", retryable: false });
  }
  const regionIndex = tryBuildIndex(datasetBytes.toString("utf8"));
  if (!regionIndex) throw new PluginError(`The region dataset at ${datasetUrl} is not a valid wilayah.sql (too few provinces)`, { kind: "api_error" });
  await writeDiskCache(settings, datasetBytes);
  return regionIndex;
}

async function loadFromDiskCache(settings, now) {
  const cachedBytes = await readDiskCache(settings, now);
  if (cachedBytes === undefined) return undefined;
  if (!hasExpectedHash(settings, cachedBytes)) {
    process.stderr.write(`wilayah-indonesia: ignoring cache ${cacheFilePath(settings)}: SHA-256 is not ${settings.expectedSha256}\n`);
    return undefined;
  }
  return tryBuildIndex(cachedBytes.toString("utf8"));
}

function tryBuildIndex(sqlText) {
  const regionIndex = buildRegionIndex(parseRegionSql(sqlText));
  const provinceCount = (regionIndex.childrenByParent.get("") ?? []).filter((code) => levelOfCode(code) === "province").length;
  return provinceCount >= MIN_PROVINCES ? regionIndex : undefined;
}

function cacheFilePath(settings) {
  return join(settings.cacheDirectory, `wilayah-${settings.ref}.sql`);
}

async function readDiskCache(settings, now) {
  if (!settings.cacheDirectory) return undefined;
  try {
    const fileStat = await stat(cacheFilePath(settings));
    if (!fileStat.isFile() || fileStat.size > MAX_DATASET_BYTES || now() - fileStat.mtimeMs >= settings.ttlMs) return undefined;
    return await readFile(cacheFilePath(settings));
  } catch (cacheError) {
    if (cacheError?.code === "ENOENT") return undefined;
    process.stderr.write(`wilayah-indonesia: ignoring unreadable cache ${cacheFilePath(settings)}: ${cacheError.message}\n`);
    return undefined;
  }
}

// Written to a temporary name first, so a concurrent reader never sees half a file. A failed write only logs.
async function writeDiskCache(settings, datasetBytes) {
  if (!settings.cacheDirectory) return;
  const temporaryPath = `${cacheFilePath(settings)}.${process.pid}.tmp`;
  try {
    await mkdir(settings.cacheDirectory, { recursive: true });
    await writeFile(temporaryPath, datasetBytes);
    await rename(temporaryPath, cacheFilePath(settings));
  } catch (cacheError) {
    process.stderr.write(`wilayah-indonesia: could not write cache ${cacheFilePath(settings)}: ${cacheError.message}\n`);
  }
}
