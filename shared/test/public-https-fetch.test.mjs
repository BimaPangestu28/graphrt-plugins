import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPublicHttpsToFile, fetchPublicHttps, MAX_REDIRECTS } from "../lib/public-https-fetch.mjs";

const PUBLIC_ADDRESS = "93.184.216.34";
const publicResolver = async () => [PUBLIC_ADDRESS];

function createSequenceFetch(responses) {
  const calls = [];
  const sequenceFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = "", headers = {} } = responses.shift() ?? {};
    return new Response(status === 204 ? null : body, { status, headers });
  };
  sequenceFetch.calls = calls;
  return sequenceFetch;
}

const isInvalidInput = (error) => error.kind === "invalid_input";

async function withTemporaryDirectory(runWithDirectory) {
  const directory = await mkdtemp(join(tmpdir(), "public-https-"));
  try {
    return await runWithDirectory(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("fetchPublicHttps returns a public https response and asks fetch not to follow redirects", async () => {
  const fakeFetch = createSequenceFetch([{ body: "hello" }]);
  const response = await fetchPublicHttps("https://cdn.example.com/a.png", { fetchImpl: fakeFetch, resolveHostAddresses: publicResolver, label: "url" });
  assert.equal(await response.text(), "hello");
  assert.equal(fakeFetch.calls[0].init.redirect, "manual");
});

const REFUSED_URLS = [
  ["http URL", "http://cdn.example.com/a.png", publicResolver],
  ["localhost", "https://localhost/a.png", publicResolver],
  ["*.localhost", "https://api.localhost/a.png", publicResolver],
  ["loopback literal", "https://127.0.0.1/a.png", publicResolver],
  ["private literal", "https://10.1.2.3/a.png", publicResolver],
  ["metadata literal", "https://169.254.169.254/latest", publicResolver],
  ["IPv6 loopback", "https://[::1]/a.png", publicResolver],
  ["IPv4-mapped IPv6", "https://[::ffff:127.0.0.1]/a.png", publicResolver],
  ["name resolving to a private address", "https://internal.example.com/a.png", async () => ["192.168.1.5"]],
  ["name resolving to nothing", "https://nothing.example.com/a.png", async () => []],
  ["malformed URL", "not a url", publicResolver],
];

for (const [caseName, refusedUrl, resolveHostAddresses] of REFUSED_URLS) {
  test(`fetchPublicHttps refuses a ${caseName} before any request`, async () => {
    const fakeFetch = createSequenceFetch([{ body: "x" }]);
    await assert.rejects(fetchPublicHttps(refusedUrl, { fetchImpl: fakeFetch, resolveHostAddresses, label: "url" }), isInvalidInput);
    assert.equal(fakeFetch.calls.length, 0);
  });
}

test("fetchPublicHttps checks every redirect hop and refuses one to a private host", async () => {
  const fakeFetch = createSequenceFetch([
    { status: 302, headers: { location: "https://other.example.com/b.png" } },
    { status: 301, headers: { location: "https://10.0.0.1/c.png" } },
  ]);
  await assert.rejects(
    fetchPublicHttps("https://cdn.example.com/a.png", { fetchImpl: fakeFetch, resolveHostAddresses: publicResolver, label: "url" }),
    (error) => isInvalidInput(error) && /redirected to https:\/\/10\.0\.0\.1/.test(error.message),
  );
  assert.equal(fakeFetch.calls.length, 2);
});

test("fetchPublicHttps follows public redirects and gives up after MAX_REDIRECTS", async () => {
  const redirect = { status: 302, headers: { location: "/next" } };
  const followed = createSequenceFetch([redirect, { body: "done" }]);
  const response = await fetchPublicHttps("https://cdn.example.com/a", { fetchImpl: followed, resolveHostAddresses: publicResolver, label: "url" });
  assert.equal(await response.text(), "done");
  assert.equal(followed.calls[1].url, "https://cdn.example.com/next");
  const endless = createSequenceFetch(Array.from({ length: MAX_REDIRECTS + 2 }, () => ({ ...redirect })));
  await assert.rejects(fetchPublicHttps("https://cdn.example.com/a", { fetchImpl: endless, resolveHostAddresses: publicResolver, label: "url" }), isInvalidInput);
});

test("downloadPublicHttpsToFile streams the body to <directory>/<name><ext from content-type>", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fakeFetch = createSequenceFetch([{ body: "PNGDATA", headers: { "content-type": "image/png" } }]);
    const savedFile = await downloadPublicHttpsToFile("https://cdn.example.com/out?sig=1", {
      directory,
      fileBaseName: "generate_image-1",
      fetchImpl: fakeFetch,
      resolveHostAddresses: publicResolver,
    });
    assert.deepEqual(savedFile, {
      url: "https://cdn.example.com/out?sig=1",
      path: join(directory, "generate_image-1.png"),
      bytes: 7,
      content_type: "image/png",
    });
    assert.equal(await readFile(savedFile.path, "utf8"), "PNGDATA");
  });
});

test("downloadPublicHttpsToFile falls back to the URL's extension, then .bin", async () => {
  await withTemporaryDirectory(async (directory) => {
    const genericBinary = { "content-type": "application/octet-stream" };
    const fakeFetch = createSequenceFetch([{ body: "a", headers: genericBinary }, { body: "b", headers: genericBinary }]);
    const options = { directory, fetchImpl: fakeFetch, resolveHostAddresses: publicResolver };
    const fromUrl = await downloadPublicHttpsToFile("https://cdn.example.com/clip.MP4", { ...options, fileBaseName: "one" });
    const fallback = await downloadPublicHttpsToFile("https://cdn.example.com/blob", { ...options, fileBaseName: "two" });
    assert.equal(fromUrl.path, join(directory, "one.mp4"));
    assert.equal(fallback.path, join(directory, "two.bin"));
  });
});

test("downloadPublicHttpsToFile creates a missing directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    const nestedDirectory = join(directory, "media", "today");
    const fakeFetch = createSequenceFetch([{ body: "x", headers: { "content-type": "audio/mpeg" } }]);
    const savedFile = await downloadPublicHttpsToFile("https://cdn.example.com/a", { directory: nestedDirectory, fileBaseName: "a", fetchImpl: fakeFetch, resolveHostAddresses: publicResolver });
    assert.equal(savedFile.path, join(nestedDirectory, "a.mp3"));
  });
});

test("downloadPublicHttpsToFile refuses a file name that could leave the directory", async () => {
  await withTemporaryDirectory(async (directory) => {
    for (const fileBaseName of ["../escape", "a/b", "a\\b", "", ".."]) {
      const fakeFetch = createSequenceFetch([{ body: "x" }]);
      await assert.rejects(downloadPublicHttpsToFile("https://cdn.example.com/a", { directory, fileBaseName, fetchImpl: fakeFetch, resolveHostAddresses: publicResolver }), isInvalidInput);
      assert.equal(fakeFetch.calls.length, 0);
    }
  });
});

test("downloadPublicHttpsToFile enforces maxBytes from content-length and while streaming, leaving no partial file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const declaredTooLarge = createSequenceFetch([{ body: "12345", headers: { "content-length": "5" } }]);
    const options = { directory, fileBaseName: "big", resolveHostAddresses: publicResolver, maxBytes: 4 };
    await assert.rejects(downloadPublicHttpsToFile("https://cdn.example.com/a", { ...options, fetchImpl: declaredTooLarge }), (error) => isInvalidInput(error) && /4 bytes/.test(error.message));
    const undeclaredTooLarge = async () => new Response(new ReadableStream({ start: (controller) => (controller.enqueue(new TextEncoder().encode("123456")), controller.close()) }));
    await assert.rejects(downloadPublicHttpsToFile("https://cdn.example.com/a", { ...options, fetchImpl: undeclaredTooLarge }), isInvalidInput);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("downloadPublicHttpsToFile reports an HTTP failure as api_error without writing a file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fakeFetch = createSequenceFetch([{ status: 403, body: "denied" }]);
    await assert.rejects(
      downloadPublicHttpsToFile("https://cdn.example.com/a", { directory, fileBaseName: "a", fetchImpl: fakeFetch, resolveHostAddresses: publicResolver, label: "video_url" }),
      (error) => error.kind === "api_error" && /video_url/.test(error.message) && /403/.test(error.message),
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test("downloadPublicHttpsToFile turns transport failures into retryable network errors and cancellation into cancelled", async () => {
  await withTemporaryDirectory(async (directory) => {
    const options = { directory, fileBaseName: "a", resolveHostAddresses: publicResolver };
    const failingFetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    };
    await assert.rejects(downloadPublicHttpsToFile("https://cdn.example.com/a", { ...options, fetchImpl: failingFetch }), (error) => error.kind === "network_error" && error.retryable === true && /ECONNRESET/.test(error.message));
    const controller = new AbortController();
    controller.abort();
    const abortAwareFetch = async (url, init) => {
      throw init.signal.reason;
    };
    await assert.rejects(downloadPublicHttpsToFile("https://cdn.example.com/a", { ...options, fetchImpl: abortAwareFetch, signal: controller.signal }), (error) => error.kind === "cancelled");
  });
});
