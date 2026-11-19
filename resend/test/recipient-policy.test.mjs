import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRecipientsAllowed } from "../lib/recipient-policy.mjs";

// This test file is identical in brevo, sendgrid and resend (like lib/recipient-policy.mjs).
const ALLOWLIST_ENV = "TEST_TOOL_RECIPIENT_ALLOWLIST";
const toolContext = (allowlist) => ({ source: "tool", environment: allowlist === undefined ? {} : { [ALLOWLIST_ENV]: allowlist } });

test("tool sends refuse non-ASCII addresses, so U+212A (Kelvin sign) cannot case-fold onto an allowed k", () => {
  const kelvinAddress = "Kate@example.com";
  assert.equal(kelvinAddress.toLowerCase(), "kate@example.com");
  assert.throws(() => assertRecipientsAllowed(toolContext("kate@example.com"), [kelvinAddress], ALLOWLIST_ENV), (error) => error.kind === "permission_denied" && /ASCII/.test(error.message));
  assert.throws(() => assertRecipientsAllowed(toolContext(), ["josé@example.com"], ALLOWLIST_ENV), (error) => error.kind === "permission_denied");
});

test("ASCII tool recipients are matched case-insensitively; nodes are not limited", () => {
  assertRecipientsAllowed(toolContext("kate@example.com,@example.org"), ["Kate@Example.com", "ops@example.org"], ALLOWLIST_ENV);
  assert.throws(() => assertRecipientsAllowed(toolContext("@example.org"), ["kate@example.com"], ALLOWLIST_ENV), (error) => error.kind === "permission_denied");
  assertRecipientsAllowed({ source: "node", environment: { [ALLOWLIST_ENV]: "@example.org" } }, ["Kate@example.com"], ALLOWLIST_ENV);
});
