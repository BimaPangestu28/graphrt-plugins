// Unit tests for lib/recipient-policy.mjs (the same file in every B9 messaging plugin).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertToolRecipientsAllowed, guardRecipients, isRecipientAllowed, normalizeE164, parseAllowlist, wrapOperations } from "../lib/recipient-policy.mjs";

const PHONE_POLICY = { optInEnv: "X_TOOL_ALLOW_SEND", allowlistEnv: "X_TOOL_RECIPIENT_ALLOWLIST", entryKind: "phone" };
const ID_POLICY = { ...PHONE_POLICY, entryKind: "id" };
const toolContext = (allowlist) => ({ source: "tool", environment: { X_TOOL_ALLOW_SEND: "1", X_TOOL_RECIPIENT_ALLOWLIST: allowlist } });

test("normalizeE164 strips formatting and keeps the +", () => {
  assert.equal(normalizeE164("+62 812-3456-7890", "to"), "+6281234567890");
  assert.equal(normalizeE164("+1 (555) 010.0000", "to"), "+15550100000");
});

test("normalizeE164 refuses numbers without + or with the wrong length", () => {
  for (const badNumber of ["081234567890", "6281234567890", "0062812345678", "+0812345678", "+12345", "+1234567890123456", "+62abc12345", "", undefined, "+62 812/3456"]) {
    assert.throws(() => normalizeE164(badNumber, "to"), (error) => error.kind === "invalid_input" && /`to`/.test(error.message), String(badNumber));
  }
});

test("parseAllowlist: exact numbers and explicit prefixes (trailing *) are normalised", () => {
  assert.deepEqual(parseAllowlist(" +62 812 3456 7890 , +6285 7*,, ", "X", "phone"), ["+6281234567890", "+62857*"]);
  assert.deepEqual(parseAllowlist(undefined, "X", "phone"), []);
  assert.deepEqual(parseAllowlist("Uabc123, C999", "X", "id"), ["Uabc123", "C999"]);
  assert.throws(() => parseAllowlist("U 1", "X", "id"), (error) => error.kind === "invalid_input");
  assert.throws(() => parseAllowlist("U1*", "X", "id"), (error) => error.kind === "invalid_input");
});

test("parseAllowlist refuses malformed entries and short numbers without *", () => {
  for (const badEntry of ["62812", "+", "*", "+62x", "+62812", "+6281234567890**", "+62*812"]) {
    assert.throws(() => parseAllowlist(badEntry, "X_LIST", "phone"), (error) => error.kind === "invalid_input" && error.message.includes("X_LIST"), badEntry);
  }
});

test("parseAllowlist refuses prefixes broader than 4 digits (toll fraud)", () => {
  for (const broadPrefix of ["+*", "+1*", "+6*", "+62*", "+628*"]) {
    assert.throws(() => parseAllowlist(broadPrefix, "X_LIST", "phone"), (error) => error.kind === "invalid_input" && /at least 4 digits/.test(error.message), broadPrefix);
  }
  assert.deepEqual(parseAllowlist("+6281*", "X", "phone"), ["+6281*"]);
});

test("isRecipientAllowed: full numbers match exactly, * entries by prefix, ids exactly", () => {
  assert.equal(isRecipientAllowed("+628123456789", ["+628123456789"], "phone"), true);
  assert.equal(isRecipientAllowed("+6281234567890", ["+628123456789"], "phone"), false, "a longer number is refused");
  assert.equal(isRecipientAllowed("+62812345678", ["+628123456789"], "phone"), false, "a shorter number is refused");
  assert.equal(isRecipientAllowed("+6281234567890", ["+62812*"], "phone"), true);
  assert.equal(isRecipientAllowed("+6285700000000", ["+62812*"], "phone"), false);
  assert.equal(isRecipientAllowed("Uabc", ["Uabc"], "id"), true);
  assert.equal(isRecipientAllowed("Uabcd", ["Uabc"], "id"), false);
});

test("assertToolRecipientsAllowed: tools need a set allowlist that matches every recipient", () => {
  assert.throws(() => assertToolRecipientsAllowed(toolContext(""), ["+6281234567890"], PHONE_POLICY), (error) => error.kind === "permission_denied" && /not set/.test(error.message));
  assert.throws(() => assertToolRecipientsAllowed(toolContext("+62812*"), ["+6281234567890", "+15550100000"], PHONE_POLICY), (error) => error.kind === "permission_denied" && error.message.includes("+15550100000"));
  assert.doesNotThrow(() => assertToolRecipientsAllowed(toolContext("+62812*, +15550100000"), ["+6281234567890", "+15550100000"], PHONE_POLICY));
  assert.throws(() => assertToolRecipientsAllowed(toolContext("Uabc"), ["Uzzz"], ID_POLICY), (error) => error.kind === "permission_denied");
});

test("assertToolRecipientsAllowed: nodes and tools without the opt-in are not checked here", () => {
  assert.doesNotThrow(() => assertToolRecipientsAllowed({ source: "node", environment: {} }, ["+15550100000"], PHONE_POLICY));
  assert.doesNotThrow(() => assertToolRecipientsAllowed({ source: "tool", environment: { X_TOOL_RECIPIENT_ALLOWLIST: "" } }, ["+15550100000"], PHONE_POLICY));
});

test("guardRecipients prepares the args and checks before running", async () => {
  const seenArgs = [];
  const operation = { name: "send", run: async ({ args }) => (seenArgs.push(args), { data: "sent" }) };
  const guarded = guardRecipients(operation, (args) => ({ args: { ...args, to: normalizeE164(args.to, "to") }, recipients: [normalizeE164(args.to, "to")] }), PHONE_POLICY);
  await assert.rejects(guarded.run({ ...toolContext("+1555*"), args: { to: "+62 812 3456 7890" } }), (error) => error.kind === "permission_denied");
  assert.equal(seenArgs.length, 0);
  assert.deepEqual(await guarded.run({ ...toolContext("+6281234567890"), args: { to: "+62 812 3456 7890" } }), { data: "sent" });
  assert.deepEqual(seenArgs, [{ to: "+6281234567890" }]);
});

test("wrapOperations replaces named operations and refuses unknown names", () => {
  const definition = { name: "x", operations: [{ name: "a" }, { name: "b" }] };
  const wrapped = wrapOperations(definition, { b: (operation) => ({ ...operation, wrapped: true }) });
  assert.deepEqual(wrapped.operations, [{ name: "a" }, { name: "b", wrapped: true }]);
  assert.throws(() => wrapOperations(definition, { c: (operation) => operation }), /no operation `c`/);
});
