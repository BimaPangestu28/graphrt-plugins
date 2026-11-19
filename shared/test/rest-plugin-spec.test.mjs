import { test } from "node:test";
import assert from "node:assert/strict";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";

const validOperation = () => ({
  name: "get_item",
  title: "Get item",
  description: "Read one item",
  method: "GET",
  path: "/items/{item_id}",
  params: { item_id: { in: "path", type: "string", required: true, description: "Item id" } },
});

const validSpec = (overrides = {}) => ({
  name: "demo-api",
  version: "0.1.0",
  description: "Demo API",
  baseUrl: "https://api.example.com/v1",
  auth: { type: "bearer", env: "DEMO_TOKEN" },
  operations: [validOperation()],
  ...overrides,
});

const withOperation = (operationOverrides) => validSpec({ operations: [{ ...validOperation(), ...operationOverrides }] });

test("a valid spec loads", () => {
  assert.equal(defineRestPlugin(validSpec()).name, "demo-api");
});

// [case name, spec, expected message fragment]
const INVALID_SPECS = [
  ["missing name", validSpec({ name: undefined }), /`name`/],
  ["non kebab-case name", validSpec({ name: "Demo_API" }), /kebab-case/],
  ["missing version", validSpec({ version: undefined }), /`version`/],
  ["unknown top-level key", validSpec({ baseURL: "https://x" }), /unknown key `baseURL`/],
  ["non-https base URL", validSpec({ baseUrl: "http://api.example.com" }), /https/],
  ["invalid base URL", validSpec({ baseUrl: "not a url" }), /baseUrl/],
  ["missing auth", validSpec({ auth: undefined }), /`auth`/],
  ["unknown auth type", validSpec({ auth: { type: "oauth" } }), /auth type `oauth`/],
  ["bearer without env", validSpec({ auth: { type: "bearer" } }), /auth.env/],
  ["header auth without header", validSpec({ auth: { type: "header", env: "K" } }), /auth.header/],
  ["query auth without param", validSpec({ auth: { type: "query", env: "K" } }), /auth.param/],
  ["basic auth without envs", validSpec({ auth: { type: "basic" } }), /basic/],
  ["custom auth without function", validSpec({ auth: { type: "custom" } }), /auth.authorize/],
  ["unknown auth key", validSpec({ auth: { type: "bearer", env: "K", envv: "x" } }), /unknown key `envv`/],
  ["unknown error kind", validSpec({ errors: { kindByCode: { nope: "boom" } } }), /kind `boom`/],
  ["unknown errors key", validSpec({ errors: { messagePaths: "x" } }), /unknown key `messagePaths`/],
  ["no operations", validSpec({ operations: [] }), /at least one operation/],
  ["duplicate operation", validSpec({ operations: [validOperation(), validOperation()] }), /duplicate operation `get_item`/],
  ["api_request name while api_request is on", withOperation({ name: "api_request" }), /api_request/],
  ["non snake_case operation", withOperation({ name: "getItem" }), /snake_case/],
  ["missing description", withOperation({ description: "" }), /description/],
  ["unknown method", withOperation({ method: "FETCH" }), /method `FETCH`/],
  ["relative path", withOperation({ path: "items" }), /must start with "\/"/],
  ["unknown operation key", withOperation({ parms: {} }), /unknown key `parms`/],
  ["unknown param location", withOperation({ params: { item_id: { in: "cookie", type: "string", required: true } } }), /`in` must be one of path, query, body, header/],
  ["unknown param type", withOperation({ params: { item_id: { in: "path", type: "uuid", required: true } } }), /type `uuid`/],
  ["unknown param key", withOperation({ params: { item_id: { in: "path", type: "string", required: true, requried: true } } }), /unknown key `requried`/],
  ["path placeholder without param", withOperation({ path: "/items/{item_id}/{part}" }), /placeholder \{part\} has no `in: "path"` param/],
  ["path param without placeholder", withOperation({ path: "/items" }), /path param `item_id` is not used/],
  ["optional path param", withOperation({ params: { item_id: { in: "path", type: "string" } } }), /path param `item_id` must be required/],
  ["body param on GET", withOperation({ params: { ...validOperation().params, text: { in: "body", type: "string" } } }), /GET cannot have body params/],
  ["write class read on POST", withOperation({ method: "POST", write: "read" }), /`write: "read"` is only for GET/],
  ["POST without write class", withOperation({ method: "POST" }), /must declare `write`/],
  ["unknown write class", withOperation({ method: "POST", write: "maybe" }), /write class `maybe`/],
  ["raw body without exactly one body param", withOperation({ method: "POST", write: "unsafe", bodyMode: "raw" }), /bodyMode "raw" needs exactly one body param/],
  ["unknown bodyMode", withOperation({ method: "POST", write: "unsafe", bodyMode: "xml" }), /bodyMode `xml`/],
  ["reserved access_token param", withOperation({ params: { ...validOperation().params, access_token: { in: "query", type: "string" } } }), /`access_token` is reserved/],
  ["header param that would override auth", withOperation({ params: { ...validOperation().params, auth: { in: "header", type: "string", wireName: "Authorization" } } }), /authorization/i],
  ["query param that would override the query credential", { ...withOperation({ params: { ...validOperation().params, key: { in: "query", type: "string" } } }), auth: { type: "query", param: "key", env: "K" } }, /credential/],
  ["bad toolPolicy", withOperation({ toolPolicy: "allow" }), /toolPolicy/],
  ["two pagination styles", withOperation({ response: { cursorPath: "next", cursorParam: "c", nextLinkHeader: true } }), /one pagination style/],
  ["cursorPath without cursorParam", withOperation({ response: { cursorPath: "next" } }), /cursorParam/],
  ["pagination with a user param named limit", withOperation({ params: { ...validOperation().params, limit: { in: "query", type: "integer" } }, response: { nextLinkHeader: true } }), /`limit` is reserved/],
  ["unknown response key", withOperation({ response: { data: "x" } }), /unknown key `data`/],
  ["job on a read", withOperation({ job: { idPath: "id", poll: { path: "/jobs/{id}" }, statusPath: "status", doneValues: ["done"] } }), /job.*write/],
  [
    "job poll path with an unknown placeholder",
    withOperation({ method: "POST", write: "unsafe", job: { idPath: "id", poll: { path: "/jobs/{job}" }, statusPath: "status", doneValues: ["done"] } }),
    /poll path placeholder \{job\}/,
  ],
  ["job without doneValues", withOperation({ method: "POST", write: "unsafe", job: { idPath: "id", poll: { path: "/jobs/{id}" }, statusPath: "status" } }), /doneValues/],
  ["download without envDir", withOperation({ download: { saveTo: { urlPaths: ["url"] } } }), /envDir/],
  ["non-https operation baseUrl", withOperation({ baseUrl: "http://geo.example.com" }), /baseUrl/],
  ["download without urlPaths", withOperation({ download: { saveTo: { envDir: "DEMO_DIR", urlPaths: [] } } }), /urlPaths/],
];

for (const [caseName, invalidSpec, expectedMessage] of INVALID_SPECS) {
  test(`defineRestPlugin rejects a spec with ${caseName}`, () => {
    assert.throws(() => defineRestPlugin(invalidSpec), (error) => {
      assert.match(error.message, expectedMessage);
      assert.match(error.message, /^(demo-api|Demo_API|rest plugin):/);
      return true;
    });
  });
}

test("a baseUrl function and https/localhost http are accepted, other http is not", () => {
  assert.doesNotThrow(() => defineRestPlugin(validSpec({ baseUrl: () => "https://x" })));
  assert.doesNotThrow(() => defineRestPlugin(validSpec({ baseUrl: "http://localhost:11434/api" })));
  assert.doesNotThrow(() => defineRestPlugin(validSpec({ baseUrl: "http://127.0.0.1:8080" })));
});

test("apiRequest: false allows an operation named api_request", () => {
  assert.doesNotThrow(() => defineRestPlugin({ ...withOperation({ name: "api_request" }), apiRequest: false }));
});
