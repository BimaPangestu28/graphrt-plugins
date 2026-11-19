import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { buildLazadaBaseString, computeLazadaSignature, stringifyParameters } from "../lib/signing.mjs";
import { buildSkuPayload, escapeXml } from "../lib/xml-payload.mjs";

test("the base string is the API path plus name/value pairs sorted by name, without sign", () => {
  const parameters = { timestamp: "1700000000000", app_key: "123456", sign_method: "sha256", access_token: "tok", order_id: "42", sign: "ignored" };
  assert.equal(buildLazadaBaseString("/order/get", parameters), "/order/getaccess_tokentokapp_key123456order_id42sign_methodsha256timestamp1700000000000");
});

test("sorting is by byte order, so uppercase names sort before lowercase", () => {
  assert.equal(buildLazadaBaseString("/x", { b: "2", B: "1", a: "0" }), "/xB1a0b2");
});

test("the signature is uppercase hex HMAC-SHA256 with the app secret", () => {
  const parameters = { app_key: "123456", timestamp: "1700000000000", sign_method: "sha256", access_token: "tok" };
  // Fixed vector, computed independently with: printf '%s' '<base string>' | openssl dgst -sha256 -hmac app-secret
  const signature = computeLazadaSignature("app-secret", "/seller/get", parameters);
  assert.equal(signature, "65D1FF4091F2E46513DF7470A1D8BC42C5C53F66CDB628F79C071BD772F77B34");
  assert.equal(signature, createHmac("sha256", "app-secret").update(buildLazadaBaseString("/seller/get", parameters)).digest("hex").toUpperCase());
  assert.match(signature, /^[0-9A-F]{64}$/);
});

test("stringifyParameters sends objects and arrays as JSON and drops empty values", () => {
  assert.deepEqual(stringifyParameters({ order_ids: [1, 2], limit: 10, flag: false, status: undefined, none: null, packReq: { a: 1 } }), { order_ids: "[1,2]", limit: "10", flag: "false", packReq: '{"a":1}' });
});

test("SKU payloads are escaped XML with only known elements", () => {
  assert.equal(escapeXml(`A&B <"x'>`), "A&amp;B &lt;&quot;x&apos;&gt;");
  const payload = buildSkuPayload([{ seller_sku: "K<1>", quantity: 5, Evil: "<x/>" }], [["seller_sku", "SellerSku"], ["quantity", "Quantity"]], ["quantity"]);
  assert.equal(payload, '<?xml version="1.0" encoding="UTF-8"?><Request><Product><Skus><Sku><SellerSku>K&lt;1&gt;</SellerSku><Quantity>5</Quantity></Sku></Skus></Product></Request>');
  assert.throws(() => buildSkuPayload([], [], ["quantity"]), (error) => error.kind === "invalid_input");
  assert.throws(() => buildSkuPayload([{ quantity: 1 }], [], ["quantity"]), (error) => error.message.includes("seller_sku"));
  assert.throws(() => buildSkuPayload([{ seller_sku: "a" }], [], ["quantity"]), (error) => error.message.includes("needs one of quantity"));
  assert.throws(() => buildSkuPayload(Array.from({ length: 51 }, () => ({ seller_sku: "a", quantity: 1 })), [], ["quantity"]), (error) => error.message.includes("at most 50"));
});
