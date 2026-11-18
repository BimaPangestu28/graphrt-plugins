import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTACHMENTS, MAX_REDIRECTS, loadAttachments } from "../lib/attachments.mjs";

const PUBLIC_ADDRESS = "93.184.216.34";

async function withDirectories(testBody) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "email-attach-"));
  const allowedDirectory = join(rootDirectory, "allowed");
  const otherDirectory = join(rootDirectory, "allowed-other");
  await mkdir(allowedDirectory);
  await mkdir(otherDirectory);
  try {
    await testBody({ allowedDirectory, otherDirectory });
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

function createFakeResponse({ status = 200, chunks = [Buffer.from("PDFDATA")], headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: (async function* streamChunks() {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

// `responsesByUrl` maps a URL to response options; any other URL gets the default response.
function createFakeFetch(defaultResponse = {}, responsesByUrl = {}) {
  const fakeFetch = async (requestUrl, options) => {
    fakeFetch.requests.push({ requestUrl, options });
    return createFakeResponse(responsesByUrl[requestUrl] ?? defaultResponse);
  };
  fakeFetch.requests = [];
  return fakeFetch;
}

// Fake DNS: every name is public unless listed in `addressesByHost`. Nothing touches the network.
function createFakeResolver(addressesByHost = {}) {
  const resolveHostAddresses = async (hostname) => {
    resolveHostAddresses.lookups.push(hostname);
    return addressesByHost[hostname] ?? [PUBLIC_ADDRESS];
  };
  resolveHostAddresses.lookups = [];
  return resolveHostAddresses;
}

function networkOptions(fetchImpl, extra = {}) {
  return { allowedDirectories: [], fetchImpl, resolveHostAddresses: createFakeResolver(), ...extra };
}

test("https attachments are downloaded with the file name from the URL, redirects handled manually", async () => {
  const fakeFetch = createFakeFetch();
  const [attachment] = await loadAttachments([{ source: "https://files.example.com/inv/Invoice%2012.pdf" }], networkOptions(fakeFetch));
  assert.equal(attachment.filename, "Invoice 12.pdf");
  assert.equal(attachment.content.toString(), "PDFDATA");
  assert.ok(fakeFetch.requests[0].options.signal instanceof AbortSignal);
  assert.equal(fakeFetch.requests[0].options.redirect, "manual");
  assert.equal(fakeFetch.requests[0].options.headers, undefined, "no credentials are sent to third-party hosts");
});

test("downloads stop at the size cap, by header or while streaming", async () => {
  const streaming = createFakeFetch({ chunks: [Buffer.alloc(6), Buffer.alloc(6)] });
  await assert.rejects(loadAttachments([{ source: "https://x.example.com/a" }], networkOptions(streaming, { maxTotalBytes: 10 })), { kind: "invalid_input" });
  const declared = createFakeFetch({ headers: { "content-length": "999" } });
  await assert.rejects(loadAttachments([{ source: "https://x.example.com/a" }], networkOptions(declared, { maxTotalBytes: 10 })), { kind: "invalid_input" });
});

const INVALID_SPECS = [
  [{ source: "http://x.example.com/a.pdf" }, "invalid_input"],
  [{ source: "file:///etc/passwd" }, "invalid_input"],
  [{ source: "relative/a.pdf" }, "invalid_input"],
  [{ source: "/etc/hosts" }, "invalid_input"],
  [{ source: "https://x.example.com/a", content_type: "text/plain\r\nX: y" }, "invalid_input"],
  [{ source: "https://x.example.com/a", filename: "a\nb.pdf" }, "invalid_input"],
  ["https://x.example.com/a", "invalid_input"],
];

for (const [spec, expectedKind] of INVALID_SPECS) {
  test(`loadAttachments refuses ${JSON.stringify(spec)}`, async () => {
    await assert.rejects(loadAttachments([spec], networkOptions(createFakeFetch())), { kind: expectedKind });
  });
}

test("each redirect hop is checked: http targets and too many hops are refused, https hops are followed", async () => {
  const toHttp = createFakeFetch({}, { "https://x.example.com/a": { status: 302, headers: { location: "http://x.example.com/a" } } });
  await assert.rejects(loadAttachments([{ source: "https://x.example.com/a" }], networkOptions(toHttp)), { kind: "invalid_input", message: /https/ });
  assert.equal(toHttp.requests.length, 1, "the http hop is never requested");
  const followed = createFakeFetch({}, { "https://x.example.com/a": { status: 301, headers: { location: "/b.pdf" } } });
  const [attachment] = await loadAttachments([{ source: "https://x.example.com/a" }], networkOptions(followed));
  assert.deepEqual(followed.requests.map((request) => request.requestUrl), ["https://x.example.com/a", "https://x.example.com/b.pdf"]);
  assert.equal(attachment.content.toString(), "PDFDATA");
  const looping = createFakeFetch({ status: 302, headers: { location: "https://x.example.com/again" } });
  await assert.rejects(loadAttachments([{ source: "https://x.example.com/a" }], networkOptions(looping)), { kind: "invalid_input", message: /redirect/ });
  assert.equal(looping.requests.length, MAX_REDIRECTS + 1);
});

const PRIVATE_URLS = [
  "https://localhost/a",
  "https://api.localhost/a",
  "https://127.0.0.1/a",
  "https://10.1.2.3/a",
  "https://172.16.0.9/a",
  "https://192.168.1.1/a",
  "https://169.254.169.254/latest/meta-data",
  "https://100.64.0.1/a",
  "https://0.0.0.0/a",
  "https://[::1]/a",
  "https://[fe80::1]/a",
  "https://[fd00::1]/a",
  "https://[::ffff:127.0.0.1]/a",
];

for (const privateUrl of PRIVATE_URLS) {
  test(`attachment URLs on loopback/private/link-local hosts are refused: ${privateUrl}`, async () => {
    const fakeFetch = createFakeFetch();
    await assert.rejects(loadAttachments([{ source: privateUrl }], networkOptions(fakeFetch)), { kind: "invalid_input", message: /private|loopback|local/ });
    assert.equal(fakeFetch.requests.length, 0);
  });
}

test("a host name that resolves to a private address is refused, also on a redirect hop", async () => {
  const resolveHostAddresses = createFakeResolver({ "intranet.example.com": ["10.0.0.5"] });
  const fakeFetch = createFakeFetch({}, { "https://x.example.com/a": { status: 302, headers: { location: "https://intranet.example.com/secret" } } });
  await assert.rejects(loadAttachments([{ source: "https://intranet.example.com/a" }], { allowedDirectories: [], fetchImpl: fakeFetch, resolveHostAddresses }), { kind: "invalid_input" });
  await assert.rejects(loadAttachments([{ source: "https://x.example.com/a" }], { allowedDirectories: [], fetchImpl: fakeFetch, resolveHostAddresses }), { kind: "invalid_input" });
  assert.deepEqual(fakeFetch.requests.map((request) => request.requestUrl), ["https://x.example.com/a"]);
});

test("HTTP errors and network failures are reported", async () => {
  await assert.rejects(loadAttachments([{ source: "https://x.example.com/a" }], networkOptions(createFakeFetch({ status: 404 }))), { kind: "not_found" });
  const failingFetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(loadAttachments([{ source: "https://x.example.com/a" }], networkOptions(failingFetch)), { kind: "network_error", message: /Nothing was sent/ });
});

test("local files load only from inside EMAIL_ALLOWED_FILE_DIRS (no prefix or symlink escapes)", () =>
  withDirectories(async ({ allowedDirectory, otherDirectory }) => {
    await writeFile(join(allowedDirectory, "ok.txt"), "hello");
    await writeFile(join(otherDirectory, "secret.txt"), "secret");
    await symlink(join(otherDirectory, "secret.txt"), join(allowedDirectory, "link.txt"));
    const [attachment] = await loadAttachments([{ source: join(allowedDirectory, "ok.txt"), filename: "renamed.txt", content_type: "text/plain" }], { allowedDirectories: [allowedDirectory] });
    assert.deepEqual([attachment.filename, attachment.contentType, attachment.content.toString()], ["renamed.txt", "text/plain", "hello"]);
    await assert.rejects(loadAttachments([{ source: join(otherDirectory, "secret.txt") }], { allowedDirectories: [allowedDirectory] }), { kind: "invalid_input" });
    await assert.rejects(loadAttachments([{ source: join(allowedDirectory, "link.txt") }], { allowedDirectories: [allowedDirectory] }), { kind: "invalid_input" });
    await assert.rejects(loadAttachments([{ source: allowedDirectory + "/" }], { allowedDirectories: [allowedDirectory] }), { kind: "invalid_input" });
  }));

test("a missing file and a file outside the allowlist get the same error (existence is not revealed)", () =>
  withDirectories(async ({ allowedDirectory, otherDirectory }) => {
    await writeFile(join(otherDirectory, "secret.txt"), "secret");
    const captureError = (localPath) => loadAttachments([{ source: localPath }], { allowedDirectories: [allowedDirectory] }).catch((loadError) => loadError);
    const outsideExisting = await captureError(join(otherDirectory, "secret.txt"));
    const outsideMissing = await captureError(join(otherDirectory, "missing.txt"));
    const insideMissing = await captureError(join(allowedDirectory, "missing.txt"));
    for (const loadError of [outsideExisting, outsideMissing, insideMissing]) assert.equal(loadError.kind, "invalid_input");
    const withoutPath = (loadError, localPath) => loadError.message.replace(localPath, "<path>");
    assert.equal(withoutPath(outsideExisting, join(otherDirectory, "secret.txt")), withoutPath(insideMissing, join(allowedDirectory, "missing.txt")));
    assert.equal(withoutPath(outsideMissing, join(otherDirectory, "missing.txt")), withoutPath(insideMissing, join(allowedDirectory, "missing.txt")));
  }));

test("a FIFO inside the allowlist is refused without blocking", () =>
  withDirectories(async ({ allowedDirectory }) => {
    const fifoPath = join(allowedDirectory, "pipe");
    const mkfifoResult = spawnSync("mkfifo", [fifoPath]);
    assert.equal(mkfifoResult.status, 0, "mkfifo is available");
    await assert.rejects(loadAttachments([{ source: fifoPath }], { allowedDirectories: [allowedDirectory] }), { kind: "invalid_input", message: /regular file/ });
  }));

test(`at most ${MAX_ATTACHMENTS} attachments`, async () => {
  const specs = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ source: "https://x.example.com/a" }));
  await assert.rejects(loadAttachments(specs, networkOptions(createFakeFetch())), { kind: "invalid_input" });
});
