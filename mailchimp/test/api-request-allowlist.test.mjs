import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRepeatedly, isAllowedReadPath, restrictApiRequestToReadPaths } from "../lib/api-request-allowlist.mjs";

// This test file is identical in every plugin that has lib/api-request-allowlist.mjs.
const PREFIXES = ["/templates", "/suppression", "/stats"];

test("decodeRepeatedly decodes until stable and refuses malformed or endless encodings", () => {
  assert.equal(decodeRepeatedly("%252e%252e"), "..");
  assert.equal(decodeRepeatedly("abc"), "abc");
  assert.equal(decodeRepeatedly("%zz"), null);
  assert.equal(decodeRepeatedly("%25252525252e"), null);
});

test("isAllowedReadPath accepts listed prefixes on a segment boundary, ignoring query, case and .json", () => {
  for (const path of ["/templates", "/templates/d-1", "/Templates/d-1?x=1", "/suppression/bounces.json", "/stats/", "/stats#x", "/templates/%64-1"]) {
    assert.equal(isAllowedReadPath(path, PREFIXES), true, path);
  }
});

test("isAllowedReadPath refuses other paths, look-alikes, dot, empty and separator segments (also multiply encoded)", () => {
  const refused = [
    "/api_keys",
    "/templatesx",
    "/templates/../api_keys",
    "/templates/%2e%2e/api_keys",
    "/templates/%252e%252e/api_keys",
    "/templates/%25252e%25252e/api_keys",
    "/templates/%2E./x",
    "/templates/.",
    "/templates/%2e",
    "/templates//x",
    "/templates/%2f..%2fapi_keys",
    "/templates/%252fapi_keys",
    "/templates/%5c..%5capi_keys",
    "/templates\\..\\api_keys",
    "/templates/%zz",
    "",
    "templates",
  ];
  for (const path of refused) assert.equal(isAllowedReadPath(path, PREFIXES), false, path);
});

test("isAllowedReadPath refuses blocked prefixes under an allowed one", () => {
  assert.equal(isAllowedReadPath("/emails/abc", ["/emails"], ["/emails/receiving"]), true);
  assert.equal(isAllowedReadPath("/emails/Receiving/abc", ["/emails"], ["/emails/receiving"]), false);
  assert.equal(isAllowedReadPath("/emails/%2572eceiving", ["/emails"], ["/emails/receiving"]), false);
});

test("a * prefix segment matches any one segment", () => {
  assert.equal(isAllowedReadPath("/lists/abc/members/x", ["/lists"], ["/lists/*/webhooks"]), true);
  assert.equal(isAllowedReadPath("/lists/abc/Webhooks/1", ["/lists"], ["/lists/*/webhooks"]), false);
  assert.equal(isAllowedReadPath("/lists/webhooks", ["/lists"], ["/lists/*/webhooks"]), true);
  assert.equal(isAllowedReadPath("/a/b/c", ["/a/*/c"]), true);
  assert.equal(isAllowedReadPath("/a/b", ["/a/*/c"]), false);
});

test("restrictApiRequestToReadPaths refuses tool calls outside the allowlist and passes nodes", async () => {
  const calls = [];
  const operation = restrictApiRequestToReadPaths({ name: "api_request", description: "Call any endpoint.", run: (context) => (calls.push(context.args.path), { data: null }) }, PREFIXES, ["/stats/secret"]);
  assert.match(operation.description, /\/templates.*except \/stats\/secret/);
  await assert.rejects(async () => operation.run({ source: "tool", args: { path: "/api_keys" } }), (error) => error.kind === "permission_denied");
  await assert.rejects(async () => operation.run({ source: "tool", args: { path: "/stats/secret" } }), (error) => error.kind === "permission_denied");
  await operation.run({ source: "tool", args: { path: "/templates" } });
  await operation.run({ source: "node", args: { path: "/api_keys" } });
  assert.deepEqual(calls, ["/templates", "/api_keys"]);
});
