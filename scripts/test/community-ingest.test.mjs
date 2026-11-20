import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  CommunityPluginRejection, MAX_COMMUNITY_V2_ENTRY_BYTES, downloadHttpsBytes, ingestCommunityPlugin, ingestCommunityPlugins,
} from "../lib/community-ingest.mjs";
import { COMMUNITY_FALLBACK_ICON_SVG, iconAssetNameFor } from "../lib/plugin-icons.mjs";
import { buildCatalogEntry, listPluginNames, sha256Hex } from "../lib/plugin-package.mjs";
import { listRepoDirectoryNames } from "../lib/community-plugins.mjs";
import { createTarGz } from "../lib/tar-archive.mjs";
import { packExternalPlugin, writeCatalogFiles } from "../pack-plugins.mjs";
import { REPO_ROOT } from "../plugins.mjs";

const PLUGIN_NAME = "acme-crm";
const VALID_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FF6600"><path d="M2 2h20v20H2z"/></svg>\n';
const PLUGIN_SOURCE = "process.stdin.resume();\n";

/** Builds a community tarball the way scripts/pack-plugins.mjs --plugin-dir does: everything pinned, icon at the root. */
function buildFixtureTarball({ directoryName = PLUGIN_NAME, manifestOverrides = {}, icon = VALID_ICON, extraFiles = [], pinExtraFiles = true } = {}) {
  const files = [{ path: "plugin.mjs", content: Buffer.from(PLUGIN_SOURCE) }, { path: "README.md", content: Buffer.from("# Acme CRM\n\n> **Warning:** Writes go to your live CRM.\n") }, ...extraFiles];
  if (icon !== null) files.push({ path: "icon.svg", content: Buffer.from(icon) });
  const pinnedFiles = files.filter(({ path }) => /\.(mjs|js|cjs|json)$/.test(path) && (pinExtraFiles || path === "plugin.mjs"));
  const manifest = {
    name: PLUGIN_NAME,
    version: "1.2.0",
    description: "Acme CRM contacts and deals",
    runtime: "process",
    command: "node",
    args: ["plugin.mjs"],
    permissions: { network: true, secrets: true, env: ["ACME_API_KEY"] },
    checksums: Object.fromEntries(pinnedFiles.map(({ path, content }) => [path, sha256Hex(content)])),
    nodes: [{ kind: "acme-crm.list_contacts", title: "List contacts", description: "Lists contacts", config_schema: { type: "object", properties: { limit: { type: "integer" } } }, outputs: [{ name: "contacts", type: "array" }] }],
    tools: [{ name: "list_contacts", description: "Lists CRM contacts", parameters: { type: "object" } }],
    ...manifestOverrides,
  };
  const entries = [{ path: directoryName, type: "directory" }, { path: `${directoryName}/graphrt-plugin.json`, type: "file", content: Buffer.from(JSON.stringify(manifest, null, 2)) }];
  for (const { path, content } of files) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) entries.push({ path: `${directoryName}/${segments.slice(0, depth).join("/")}`, type: "directory" });
    entries.push({ path: `${directoryName}/${path}`, type: "file", content });
  }
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  return createTarGz(uniqueEntries, { mtimeSeconds: 1_700_000_000 });
}

function registryEntryFor(tarballBytes, overrides = {}) {
  return {
    repository_url: "https://github.com/acme/graphrt-acme-crm",
    tag: "v1.2.0",
    tarball_url: "https://github.com/acme/graphrt-acme-crm/releases/download/v1.2.0/acme-crm-1.2.0.tar.gz",
    tarball_sha256: sha256Hex(tarballBytes),
    publisher: "Acme Inc.",
    display_name: "Acme CRM",
    status: "beta",
    status_reason: "Official Acme API; reviewed at v1.2.0.",
    tos_risk: "low",
    reviewed_by: "a-maintainer",
    reviewed_at: "2026-11-20",
    ...overrides,
  };
}

/** A fake of this repo's releases: mirror tags to bytes, and every release created. */
function createFakeMirror(existingMirrors = {}) {
  const releases = new Map(Object.entries(existingMirrors));
  const created = [];
  return {
    created,
    readMirroredTarball: (releaseTag) => releases.get(releaseTag) ?? null,
    createMirrorRelease: (release) => {
      created.push({ ...release, bytes: readFileSync(release.tarballPath) });
      releases.set(release.releaseTag, readFileSync(release.tarballPath));
    },
  };
}

function createContext(tarballBytes, overrides = {}) {
  const workDirectory = mkdtempSync(join(tmpdir(), "community-ingest-test-"));
  const downloads = [];
  const logLines = [];
  const context = {
    officialNames: listRepoDirectoryNames(),
    workDirectory,
    mirror: createFakeMirror(),
    downloadTarball: async (url) => {
      downloads.push(url);
      return tarballBytes;
    },
    log: (line) => logLines.push(line),
    ...overrides,
  };
  return { context, downloads, logLines, cleanUp: () => rmSync(workDirectory, { recursive: true, force: true }) };
}

async function ingestOrReason(tarballBytes, entryOverrides = {}, contextOverrides = {}, pluginName = PLUGIN_NAME) {
  const { context, cleanUp } = createContext(tarballBytes, contextOverrides);
  try {
    await ingestCommunityPlugin(pluginName, registryEntryFor(tarballBytes, entryOverrides), context);
    return null;
  } catch (error) {
    assert.ok(error instanceof CommunityPluginRejection, `expected a rejection, got ${error.stack}`);
    return error.reason;
  } finally {
    cleanUp();
  }
}

test("ingests a community tarball end to end: download, verify, mirror, v1 + v2 entries and the detail file", async () => {
  const tarballBytes = buildFixtureTarball();
  const { context, downloads, cleanUp } = createContext(tarballBytes);
  const catalogDirectory = mkdtempSync(join(tmpdir(), "community-catalog-test-"));
  try {
    const { released, skipped } = await ingestCommunityPlugins({ [PLUGIN_NAME]: registryEntryFor(tarballBytes) }, context);
    assert.deepEqual(skipped, []);
    assert.deepEqual(downloads, ["https://github.com/acme/graphrt-acme-crm/releases/download/v1.2.0/acme-crm-1.2.0.tar.gz"]);
    assert.equal(released[0].mirrorAction, "mirror created");
    const [mirrorRelease] = context.mirror.created;
    assert.equal(mirrorRelease.releaseTag, "community-acme-crm-v1.2.0");
    assert.deepEqual(mirrorRelease.bytes, tarballBytes, "the mirror holds the exact reviewed bytes");
    assert.equal(mirrorRelease.prerelease, false);
    assert.match(mirrorRelease.notes, /Reviewed by @a-maintainer on 2026-11-20/);

    const officialManifest = JSON.parse(readFileSync(join(REPO_ROOT, "currency-rates", "graphrt-plugin.json"), "utf8"));
    const official = { tarballName: "currency-rates-0.1.0.tar.gz", sha256: "b".repeat(64), sizeBytes: 10, manifest: officialManifest };
    official.catalogEntry = buildCatalogEntry(officialManifest, official);
    const catalogFiles = writeCatalogFiles(catalogDirectory, [official, released[0]]);

    const v1Entry = JSON.parse(readFileSync(catalogFiles.indexPath, "utf8")).plugins.find((entry) => entry.name === PLUGIN_NAME);
    const v2Catalog = JSON.parse(readFileSync(catalogFiles.indexV2Path, "utf8"));
    const v2Entry = v2Catalog.plugins.find((entry) => entry.name === PLUGIN_NAME);
    for (const entry of [v1Entry, v2Entry]) {
      assert.equal(entry.source, "community");
      assert.equal(entry.publisher, "Acme Inc.");
      assert.equal(entry.repository_url, "https://github.com/acme/graphrt-acme-crm");
      assert.equal(entry.display_name, "Acme CRM");
      assert.equal(entry.version, "1.2.0");
      assert.equal(entry.tarball_url, "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/community-acme-crm-v1.2.0/acme-crm-1.2.0.tar.gz");
      assert.equal(entry.sha256, sha256Hex(tarballBytes));
      assert.equal(entry.size_bytes, tarballBytes.length);
      assert.equal(entry.status, "beta");
      assert.equal(entry.tos_risk, "low");
      assert.equal(entry.warning, "Writes go to your live CRM.");
      assert.equal(entry.readme_url, "https://github.com/acme/graphrt-acme-crm/blob/v1.2.0/README.md");
      assert.equal(entry.icon_url, `https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/${iconAssetNameFor(PLUGIN_NAME, Buffer.from(VALID_ICON))}`);
    }
    assert.deepEqual(v1Entry.nodes[0].config_schema, { type: "object", properties: { limit: { type: "integer" } } });
    assert.deepEqual(v2Entry.node_kinds, [{ kind: "acme-crm.list_contacts", title: "List contacts" }]);
    const officialV2Entry = v2Catalog.plugins.find((entry) => entry.name === "currency-rates");
    assert.equal(officialV2Entry.source, "official");
    assert.equal(officialV2Entry.publisher, "graphrt");

    const detailFile = catalogFiles.detailFiles.find((detail) => detail.assetName === "plugin-acme-crm-1.2.0.json");
    const detailBytes = readFileSync(detailFile.stagedPath);
    assert.equal(v2Entry.detail_url, "https://github.com/BimaPangestu28/graphrt-plugins/releases/download/catalog/plugin-acme-crm-1.2.0.json");
    assert.equal(v2Entry.detail_sha256, sha256Hex(detailBytes));
    assert.equal(v2Entry.detail_size_bytes, detailBytes.length);
    const detail = JSON.parse(detailBytes);
    assert.deepEqual(detail.tools, [{ name: "list_contacts", description: "Lists CRM contacts" }]);
    assert.deepEqual(detail.nodes[0].outputs, [{ name: "contacts", type: "array" }]);
    assert.ok(catalogFiles.iconPaths.some((iconPath) => readFileSync(iconPath, "utf8") === VALID_ICON), "the community icon is staged");
    assert.match(readFileSync(catalogFiles.sumsPath, "utf8"), new RegExp(`${sha256Hex(tarballBytes)}  acme-crm-1.2.0.tar.gz`));
  } finally {
    cleanUp();
    rmSync(catalogDirectory, { recursive: true, force: true });
  }
});

test("reuses an existing mirror with the same bytes and never downloads or recreates it", async () => {
  const tarballBytes = buildFixtureTarball();
  const mirror = createFakeMirror({ "community-acme-crm-v1.2.0": tarballBytes });
  const { context, downloads, cleanUp } = createContext(tarballBytes, { mirror });
  try {
    const ingested = await ingestCommunityPlugin(PLUGIN_NAME, registryEntryFor(tarballBytes), context);
    assert.equal(ingested.mirrorAction, "mirrored");
    assert.deepEqual(downloads, []);
    assert.deepEqual(mirror.created, []);
  } finally {
    cleanUp();
  }
});

test("a dry run reports the mirror it would create and creates nothing", async () => {
  const tarballBytes = buildFixtureTarball();
  const { context, cleanUp } = createContext(tarballBytes, { dryRun: true });
  try {
    const ingested = await ingestCommunityPlugin(PLUGIN_NAME, registryEntryFor(tarballBytes), context);
    assert.equal(ingested.mirrorAction, "would mirror");
    assert.deepEqual(context.mirror.created, []);
  } finally {
    cleanUp();
  }
});

test("--catalog-only uses mirrored tarballs only", async () => {
  const tarballBytes = buildFixtureTarball();
  assert.match(await ingestOrReason(tarballBytes, {}, { catalogOnly: true }), /not mirrored yet \(no community-acme-crm-v1.2.0 release\)/);
  const mirror = createFakeMirror({ "community-acme-crm-v1.2.0": tarballBytes });
  assert.equal(await ingestOrReason(tarballBytes, {}, { catalogOnly: true, mirror }), null);
});

test("refuses a tarball whose sha256 differs from the reviewed one, before reading it", async () => {
  const tarballBytes = buildFixtureTarball();
  const reason = await ingestOrReason(Buffer.from("not even gzip"), { tarball_sha256: sha256Hex(tarballBytes) });
  assert.match(reason, /tarball sha256 [0-9a-f]{64} does not match the reviewed/);
});

test("refuses to reuse a mirror release that holds other bytes", async () => {
  const tarballBytes = buildFixtureTarball();
  const mirror = createFakeMirror({ "community-acme-crm-v1.2.0": buildFixtureTarball({ manifestOverrides: { description: "changed" } }) });
  assert.match(await ingestOrReason(tarballBytes, {}, { mirror }), /already holds acme-crm-1.2.0.tar.gz with sha256 .* a mirrored release is never modified/);
  assert.deepEqual(mirror.created, []);
});

test("refuses manifests whose name or version do not match the entry and its tag", async () => {
  assert.match(await ingestOrReason(buildFixtureTarball({ manifestOverrides: { name: "acme-other" } })), /manifest name `acme-other` does not match the registry name/);
  assert.match(await ingestOrReason(buildFixtureTarball({ manifestOverrides: { version: "1.3.0" } })), /manifest version `1.3.0` does not match tag v1.2.0/);
  assert.match(await ingestOrReason(buildFixtureTarball({ directoryName: "other-dir" })), /tarball has no acme-crm\/graphrt-plugin.json/);
});

test("refuses names that collide with official plugins and invalid registry entries", async () => {
  const tarballBytes = buildFixtureTarball();
  const officialName = listPluginNames()[0];
  assert.match(await ingestOrReason(tarballBytes, {}, {}, officialName), /invalid registry entry: name collides with an official plugin/);
  assert.match(await ingestOrReason(tarballBytes, { tarball_url: "https://example.com/acme-crm-1.2.0.tar.gz" }), /invalid registry entry: tarball_url must be the release asset/);
});

test("refuses forbidden files and key material", async () => {
  assert.match(await ingestOrReason(buildFixtureTarball({ extraFiles: [{ path: ".env", content: Buffer.from("ACME_API_KEY=x") }] })), /refusing to ship `\.env` \(environment file\)/);
  assert.match(await ingestOrReason(buildFixtureTarball({ extraFiles: [{ path: "certs/server.pem", content: Buffer.from("x") }] })), /refusing to ship `certs\/server.pem` \(key material\)/);
});

test("refuses archive paths that escape the plugin directory", async () => {
  const safeBytes = buildFixtureTarball({ extraFiles: [{ path: "evil.txt", content: Buffer.from("x") }] });
  const tarBytes = gunzipSync(safeBytes);
  const headerOffset = tarBytes.indexOf(Buffer.from("acme-crm/evil.txt\0"));
  tarBytes.write("acme-crm/../e.txt", headerOffset, "latin1");
  const traversalBytes = gzipSync(tarBytes);
  assert.match(await ingestOrReason(traversalBytes), /unsafe archive path `acme-crm\/..\/e.txt`/);
});

test("a gzip bomb is refused by the unpacked size cap", async () => {
  const bombBytes = gzipSync(Buffer.alloc(300 * 1024 * 1024));
  assert.match(await ingestOrReason(bombBytes), /archive unpacks to more than/);
});

test("packs a plugin from its own git repository with scripts/pack-plugins.mjs --plugin-dir, ready to ingest", async () => {
  const repositoryDirectory = mkdtempSync(join(tmpdir(), "community-repo-test-"));
  const outputDirectory = mkdtempSync(join(tmpdir(), "community-pack-test-"));
  try {
    const manifest = { name: PLUGIN_NAME, version: "1.2.0", runtime: "process", command: "node", args: ["plugin.mjs"], nodes: [{ kind: "acme-crm.ping", title: "Ping", config_schema: { type: "object" } }] };
    writeFileSync(join(repositoryDirectory, "graphrt-plugin.json"), JSON.stringify(manifest));
    writeFileSync(join(repositoryDirectory, "plugin.mjs"), PLUGIN_SOURCE);
    writeFileSync(join(repositoryDirectory, "icon.svg"), VALID_ICON);
    writeFileSync(join(repositoryDirectory, ".env"), "ACME_API_KEY=never-shipped");
    mkdirSync(join(repositoryDirectory, "test"));
    writeFileSync(join(repositoryDirectory, "test", "plugin.test.mjs"), "");
    for (const gitArguments of [["init", "-q"], ["add", "graphrt-plugin.json", "plugin.mjs", "icon.svg", "test"]]) {
      assert.equal(spawnSync("git", gitArguments, { cwd: repositoryDirectory }).status, 0);
    }
    const packed = packExternalPlugin(repositoryDirectory, outputDirectory);
    assert.equal(packed.tarballName, "acme-crm-1.2.0.tar.gz");
    const tarballBytes = readFileSync(packed.tarballPath);
    const { context, cleanUp } = createContext(tarballBytes);
    try {
      const ingested = await ingestCommunityPlugin(PLUGIN_NAME, registryEntryFor(tarballBytes), context);
      assert.equal(ingested.icon.bytes.toString("utf8"), VALID_ICON, "the packed icon.svg is used");
      assert.equal(ingested.catalogEntry.operations_count, 1);
    } finally {
      cleanUp();
    }
  } finally {
    rmSync(repositoryDirectory, { recursive: true, force: true });
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("refuses code that the manifest checksums do not pin, or pin wrongly", async () => {
  const unpinned = buildFixtureTarball({ extraFiles: [{ path: "lib/helper.mjs", content: Buffer.from("export {};\n") }], pinExtraFiles: false });
  assert.match(await ingestOrReason(unpinned), /files not pinned in the manifest checksums: lib\/helper.mjs/);
  const wronglyPinned = buildFixtureTarball({ manifestOverrides: { checksums: { "plugin.mjs": "0".repeat(64) } } });
  assert.match(await ingestOrReason(wronglyPinned), /checksum mismatch for `plugin.mjs`/);
});

test("refuses node parameters graphrt reserves", async () => {
  const nodes = [{ kind: "acme-crm.list_contacts", title: "List", config_schema: { type: "object", properties: { timeout: { type: "integer" } } } }];
  assert.match(await ingestOrReason(buildFixtureTarball({ manifestOverrides: { nodes } })), /node parameters graphrt reserves .*`timeout`/);
});

test("falls back to the neutral icon, with a log line, when icon.svg is missing or unsafe", async () => {
  for (const icon of [null, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script></svg>']) {
    const tarballBytes = buildFixtureTarball({ icon });
    const { context, logLines, cleanUp } = createContext(tarballBytes);
    try {
      const ingested = await ingestCommunityPlugin(PLUGIN_NAME, registryEntryFor(tarballBytes), context);
      assert.equal(ingested.icon.bytes.toString("utf8"), COMMUNITY_FALLBACK_ICON_SVG);
      assert.ok(ingested.catalogEntry.icon_url.endsWith(`/${iconAssetNameFor(PLUGIN_NAME, Buffer.from(COMMUNITY_FALLBACK_ICON_SVG))}`));
      assert.match(logLines.join("\n"), icon === null ? /no icon.svg in the tarball root; using the neutral fallback icon/ : /icon.svg rejected \(.*not allowed.*\); using the neutral fallback icon/);
    } finally {
      cleanUp();
    }
  }
});

test("refuses a detail file that would change a published one, and oversized index entries", async () => {
  const tarballBytes = buildFixtureTarball();
  const findPublishedCatalogSha256 = (assetName) => (assetName === "plugin-acme-crm-1.2.0.json" ? "0".repeat(64) : undefined);
  assert.match(await ingestOrReason(tarballBytes, {}, { findPublishedCatalogSha256 }), /plugin-acme-crm-1.2.0.json is already published with other bytes/);
  const manyTools = Array.from({ length: 2000 }, (unused, index) => ({ name: `tool_${index}`, description: "x" }));
  assert.match(await ingestOrReason(buildFixtureTarball({ manifestOverrides: { tools: manyTools } })), new RegExp(`index-v2.json entry is \\d+ bytes; the limit is ${MAX_COMMUNITY_V2_ENTRY_BYTES}`));
});

test("skips failing entries with their reason and keeps the good ones", async () => {
  const goodBytes = buildFixtureTarball();
  const { context, cleanUp } = createContext(goodBytes);
  try {
    const registry = { [PLUGIN_NAME]: registryEntryFor(goodBytes), "acme-bad": registryEntryFor(goodBytes, { tag: "latest" }) };
    const { released, skipped } = await ingestCommunityPlugins(registry, context);
    assert.deepEqual(released.map(({ catalogEntry }) => catalogEntry.name), [PLUGIN_NAME]);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].name, "acme-bad");
    assert.equal(skipped[0].source, "community");
    assert.match(skipped[0].reason, /tag `latest` must be v<semver>/);
  } finally {
    cleanUp();
  }
});

test("a failing download is a skip reason, not a crash", async () => {
  const tarballBytes = buildFixtureTarball();
  const downloadTarball = async () => {
    throw new Error("download: HTTP 404 from github.com");
  };
  assert.match(await ingestOrReason(tarballBytes, {}, { downloadTarball }), /HTTP 404/);
});

function fakeResponse(status, { headers = {}, body = Buffer.alloc(0) } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: (async function* streamBody() {
      yield body;
    })(),
  };
}

test("downloads over https through GitHub's redirect, with a size cap", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.startsWith("https://github.com/")) return fakeResponse(302, { headers: { location: "https://release-assets.githubusercontent.com/x?sig=1" } });
    return fakeResponse(200, { body: Buffer.from("tarball") });
  };
  const bytes = await downloadHttpsBytes("https://github.com/acme/repo/releases/download/v1/a.tar.gz", { fetchImpl });
  assert.equal(bytes.toString(), "tarball");
  assert.deepEqual(requested, ["https://github.com/acme/repo/releases/download/v1/a.tar.gz", "https://release-assets.githubusercontent.com/x?sig=1"]);
});

test("refuses non-https hops, other hosts, oversized bodies and error statuses", async () => {
  const redirectTo = (location) => async (url) => (url.includes("github.com/") ? fakeResponse(302, { headers: { location } }) : fakeResponse(200));
  const url = "https://github.com/acme/repo/releases/download/v1/a.tar.gz";
  await assert.rejects(downloadHttpsBytes("http://github.com/a", { fetchImpl: async () => fakeResponse(200) }), /refusing non-https/);
  await assert.rejects(downloadHttpsBytes(url, { fetchImpl: redirectTo("http://objects.githubusercontent.com/x") }), /refusing non-https/);
  await assert.rejects(downloadHttpsBytes(url, { fetchImpl: redirectTo("https://evil.example/x") }), /refusing host evil.example/);
  await assert.rejects(downloadHttpsBytes(url, { maxBytes: 4, fetchImpl: async () => fakeResponse(200, { headers: { "content-length": "100" } }) }), /more than the 4-byte limit/);
  await assert.rejects(downloadHttpsBytes(url, { maxBytes: 4, fetchImpl: async () => fakeResponse(200, { body: Buffer.alloc(10) }) }), /body is more than the 4-byte limit/);
  await assert.rejects(downloadHttpsBytes(url, { fetchImpl: async () => fakeResponse(404) }), /HTTP 404 from github.com/);
  await assert.rejects(downloadHttpsBytes(url, { fetchImpl: async () => fakeResponse(302, { headers: { location: url } }) }), /more than 5 redirects/);
});
