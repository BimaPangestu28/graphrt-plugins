import { test } from "node:test";
import assert from "node:assert/strict";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";
import { buildSpec } from "./fixtures/rest-test-helpers.mjs";

const operation = (overrides) => ({ name: "op", title: "Op", description: "d", path: "/x", ...overrides });
const post = (overrides) => operation({ method: "POST", write: "unsafe", ...overrides });
const job = (overrides) => ({ idPath: "id", poll: { path: "/jobs/{id}" }, statusPath: "status", doneValues: ["done"], ...overrides });

// [case name, spec, expected message fragment]
const INVALID_SPECS = [
  ["GET with body pagination", buildSpec([operation({ response: { cursorPath: "next", cursorParam: "after", paramsIn: "body" } })]), /paramsIn: "body".*GET/],
  ["raw body with body pagination", buildSpec([post({ write: "idempotent", bodyMode: "raw", params: { q: { in: "body", type: "object" } }, response: { cursorPath: "n", cursorParam: "a" } })]), /raw.*pagination/],
  ["request timeoutMs beyond the host timeout", buildSpec([post({ timeoutMs: 600000 })]), /timeoutMs 600000.*limits.timeout_ms/],
  ["plugin timeoutMs beyond the host timeout", buildSpec([operation({})], { timeoutMs: 200000 }), /timeoutMs 200000/],
  ["job timeout beyond the host timeout", buildSpec([post({ job: job({ timeoutMs: 300000 }) })]), /job.timeoutMs 300000.*limits.timeout_ms/],
  ["job with a host timeout too short to poll", buildSpec([post({ job: job() })], { limits: { timeout_ms: 15000 } }), /limits.timeout_ms/],
  ["dangerous wireName segment", buildSpec([post({ params: { a: { in: "body", type: "string", wireName: "__proto__.x" } } })]), /__proto__/],
  ["duplicate wireNames", buildSpec([operation({ params: { a: { in: "query", type: "string", wireName: "q" }, b: { in: "query", type: "string", wireName: "q" } } })]), /duplicate.*`q`/],
  ["duplicate header wireNames ignoring case", buildSpec([operation({ params: { a: { in: "header", type: "string", wireName: "X-A" }, b: { in: "header", type: "string", wireName: "x-a" } } })]), /duplicate/],
  ["param colliding with limitParam", buildSpec([operation({ params: { size: { in: "query", type: "integer", wireName: "page_size" } }, response: { cursorPath: "n", cursorParam: "c", limitParam: "page_size" } })]), /page_size.*pagination/],
  ["default of the wrong type", buildSpec([operation({ params: { a: { in: "query", type: "integer", default: "10" } } })]), /default/],
  ["enum values of the wrong type", buildSpec([operation({ params: { a: { in: "query", type: "string", enum: ["a", 1] } } })]), /enum/],
  ["default outside the enum", buildSpec([operation({ params: { a: { in: "query", type: "string", enum: ["a"], default: "b" } } })]), /default/],
  ["path param id colliding with job {id} (refused as a graphrt-reserved name first)", buildSpec([post({ path: "/models/{id}/jobs", params: { id: { in: "path", type: "string", required: true } }, job: job() })]), /param `id`/],
  ["invalid header wireName", buildSpec([operation({ params: { a: { in: "header", type: "string", wireName: "X Bad" } } })]), /header name/],
  ["invalid constant header name", buildSpec([operation({ constants: { headers: { "Bad Header": "1" } } })]), /header name/],
  ["constant colliding with a param", buildSpec([post({ params: { stream: { in: "body", type: "boolean" } }, constants: { body: { stream: false } } })]), /constant.*stream/],
  ["unknown query style", buildSpec([operation({ params: { a: { in: "query", type: "array", style: "pipes" } } })]), /style/],
  ["style on a non-query param", buildSpec([post({ params: { a: { in: "body", type: "array", style: "repeat" } } })]), /style/],
  ["file param outside multipart", buildSpec([post({ params: { f: { in: "body", type: "string", file: true } } })]), /file.*multipart/],
  ["text body with two params", buildSpec([post({ bodyMode: "text", params: { a: { in: "body", type: "string" }, b: { in: "body", type: "string" } } })]), /text.*one body param/],
  ["sendCredential without an operation baseUrl", buildSpec([operation({ sendCredential: false })]), /sendCredential/],
  ["allowedHostSuffix without a leading dot", buildSpec([operation({})], { allowedHostSuffix: "atlassian.net" }), /allowedHostSuffix/],
  ["static baseUrl outside allowedHostSuffix", buildSpec([operation({})], { allowedHostSuffix: ".atlassian.net" }), /allowedHostSuffix/],
  ["job poll with both path and urlPath", buildSpec([post({ job: job({ poll: { path: "/j/{id}", urlPath: "urls.get" } }) })]), /poll.*path.*urlPath/],
  ["job allowedHosts that are not host names", buildSpec([post({ job: job({ allowedHosts: ["https://x.com"] }) })]), /allowedHosts/],
  ["saveTo without urlPaths or base64Paths", buildSpec([operation({ download: { saveTo: { envDir: "PROBE_OUT" } } })]), /urlPaths or base64Paths/],
  ["binary response with pagination", buildSpec([operation({ response: { binary: { envDir: "PROBE_OUT" }, nextLinkHeader: true } })]), /binary/],
  ["lastItemCursor without param", buildSpec([operation({ response: { lastItemCursor: { itemIdPath: "id" } } })]), /lastItemCursor.param/],
  ["oauth2 with an http token URL", buildSpec([operation({})], { auth: { type: "oauth2", grant: "client_credentials", tokenUrl: "http://auth.example.com/t", clientIdEnv: "A", clientSecretEnv: "B" } }), /tokenUrl/],
  ["oauth2 refresh_token without refreshTokenEnv", buildSpec([operation({})], { auth: { type: "oauth2", grant: "refresh_token", tokenUrl: "https://auth.example.com/t", clientIdEnv: "A", clientSecretEnv: "B" } }), /refreshTokenEnv/],
  ["GET body params (Node fetch cannot send them)", buildSpec([operation({ params: { q: { in: "body", type: "object" } } })]), /POST.*idempotent/],
];

for (const [caseName, invalidSpec, expectedMessage] of INVALID_SPECS) {
  test(`defineRestPlugin rejects ${caseName}`, () => {
    assert.throws(() => defineRestPlugin(invalidSpec), (error) => (assert.match(error.message, expectedMessage), true));
  });
}

test("a job fits when limits.timeout_ms is raised", () => {
  assert.doesNotThrow(() => defineRestPlugin(buildSpec([post({ job: job({ timeoutMs: 300000 }) })], { limits: { timeout_ms: 330000 } })));
});
