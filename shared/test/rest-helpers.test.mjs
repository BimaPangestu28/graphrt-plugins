import { test } from "node:test";
import assert from "node:assert/strict";
import { createBodyErrorDetector, createErrorParser } from "../lib/rest-errors.mjs";
import { parseNextLink } from "../lib/rest-response.mjs";
import { createAuthorizer, createCredentialResolver, describeAuthEnv } from "../lib/rest-auth.mjs";

test("createErrorParser returns {} for bodies it does not understand, so the client's generic message applies", () => {
  const parseError = createErrorParser({ messagePath: "error.message" });
  assert.deepEqual(parseError(500, { text: "<html>" }), {});
  assert.deepEqual(parseError(500, "plain"), {});
});

test("createErrorParser tries message paths in order and marks retryable codes (numbers or strings)", () => {
  const parseError = createErrorParser({ messagePath: ["detail", "error.message"], codePath: "error.code", retryableCodes: ["409"] });
  assert.deepEqual(parseError(409, { error: { message: "Conflict", code: 409 } }), { message: "Conflict (409)", retryable: true });
});

test("createErrorParser reads retry hints in seconds by default, or milliseconds", () => {
  assert.equal(createErrorParser({ retryAfterPath: "wait" })(429, { wait: 2 }).retryAfterMs, 2000);
  assert.equal(createErrorParser({ retryAfterPath: "wait", retryAfterUnit: "milliseconds" })(429, { wait: 250 }).retryAfterMs, 250);
  assert.equal(createErrorParser({ retryAfterPath: "wait" })(429, { wait: "soon" }).retryAfterMs, undefined);
});

test("createBodyErrorDetector is off without okPath/errorPath and tolerates bodies without the ok field", () => {
  assert.equal(createBodyErrorDetector({ messagePath: "m" }), undefined);
  const detectBodyError = createBodyErrorDetector({ okPath: "ok" });
  assert.equal(detectBodyError({ result: 1 }), null);
  assert.equal(detectBodyError({ ok: true }), null);
  assert.equal(detectBodyError({ ok: false }).kind, "api_error");
});

test("createBodyErrorDetector falls back to the errorPath value for the message", () => {
  const detectBodyError = createBodyErrorDetector({ errorPath: "errors" });
  assert.match(detectBodyError({ errors: [{ field: "x" }] }).message, /field/);
  assert.equal(detectBodyError({ errors: "Bad thing" }).message, "Bad thing");
  assert.equal(detectBodyError({ errors: [] }).kind, "api_error", "an empty array is still truthy: the API reported errors");
});

test("parseNextLink finds rel=next among several links and ignores others", () => {
  const linkHeader = '<https://a.example/x?page=1>; rel="prev", <https://a.example/x?page=3>; rel="next", <https://a.example/x?page=9>; rel="last"';
  assert.equal(parseNextLink(linkHeader), "https://a.example/x?page=3");
  assert.equal(parseNextLink('<https://a.example/x?page=9>; rel="last"'), null);
  assert.equal(parseNextLink('<https://a.example/x?page=2>; rel=next'), "https://a.example/x?page=2");
  assert.equal(parseNextLink(null), null);
});

test("describeAuthEnv names the credential env and the other envs for each auth type", () => {
  assert.deepEqual(describeAuthEnv({ type: "bearer", env: "T" }), { tokenEnv: "T", extraEnv: [] });
  assert.deepEqual(describeAuthEnv({ type: "basic", userEnv: "U", passwordEnv: "P" }), { tokenEnv: "P", extraEnv: ["U"] });
  assert.deepEqual(describeAuthEnv({ type: "basic", tokenEnv: "K", user: "api" }), { tokenEnv: "K", extraEnv: [] });
  assert.deepEqual(describeAuthEnv({ type: "none" }), { tokenEnv: undefined, extraEnv: [] });
});

test("createCredentialResolver treats a blank env value as missing", () => {
  const resolveCredential = createCredentialResolver({ type: "bearer", env: "T" });
  assert.throws(() => resolveCredential({ environment: { T: "  " } }), (error) => error.kind === "auth_error");
});

test("createAuthorizer returns the credential and its URL-encoded form as secrets", async () => {
  const headers = {};
  const secrets = await createAuthorizer({ type: "bearer", env: "T" }, "a+b/c", {})({ headers, query: {} });
  assert.deepEqual(secrets, ["a+b/c", "a%2Bb%2Fc"]);
});
