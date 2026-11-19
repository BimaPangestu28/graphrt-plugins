import { test } from "node:test";
import assert from "node:assert/strict";
import { isTypeformReadPath } from "../lib/api-request-policy.mjs";
import { resolveTypeformBaseUrl } from "../lib/typeform-region.mjs";

test("isTypeformReadPath accepts the documented read endpoints", () => {
  const readPaths = ["/me", "/forms", "/forms/", "/forms/u6nXL7", "/forms/u6nXL7/responses?page_size=5", "/forms/u6nXL7/messages", "/workspaces", "/workspaces/ws_1", "/themes", "/themes/qHWOQ7", "/images", "/insights/u6nXL7/summary"];
  for (const readPath of readPaths) assert.equal(isTypeformReadPath(readPath), true, readPath);
});

test("isTypeformReadPath refuses webhooks (they hold signing secrets), unknown paths and traversal", () => {
  const refusedPaths = [
    "/forms/u6nXL7/webhooks",
    "/forms/u6nXL7/webhooks/tag",
    "/forms/u6nXL7/webhooks/tag/deliveries",
    "/forms/u6nXL7/../u6nXL7/webhooks",
    "/forms/..",
    "/forms/a%2Fwebhooks",
    "/forms/u6nXL7.json",
    "//forms",
    "/accounts/1/workspaces",
    "/",
    "",
    "forms",
  ];
  for (const refusedPath of refusedPaths) assert.equal(isTypeformReadPath(refusedPath), false, refusedPath);
});

test("resolveTypeformBaseUrl allows only Typeform's three API hosts", () => {
  assert.equal(resolveTypeformBaseUrl({}), "https://api.typeform.com");
  assert.equal(resolveTypeformBaseUrl({ TYPEFORM_BASE_URL: "https://api.eu.typeform.com/" }), "https://api.eu.typeform.com");
  assert.equal(resolveTypeformBaseUrl({ TYPEFORM_BASE_URL: " https://api.typeform.eu " }), "https://api.typeform.eu");
  for (const badUrl of ["http://api.typeform.com", "https://evil.example", "https://api.typeform.com.evil.example", "https://api.typeform.com/forms", "https://user@api.typeform.com"]) {
    assert.throws(() => resolveTypeformBaseUrl({ TYPEFORM_BASE_URL: badUrl }), /TYPEFORM_BASE_URL/, badUrl);
  }
});
