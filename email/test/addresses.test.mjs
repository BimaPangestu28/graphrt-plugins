import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSingleLine, isValidEmailAddress, normalizeMessageId, normalizeMessageIdList, parseAddressList } from "../lib/addresses.mjs";

test("parseAddressList accepts bare, named and quoted addresses separated by , or ;", () => {
  assert.deepEqual(parseAddressList("to", 'budi@example.com; "Sari, W" <sari@example.co.id>, Andi <andi@toko.id>'), [
    { name: "", address: "budi@example.com" },
    { name: "Sari, W", address: "sari@example.co.id" },
    { name: "Andi", address: "andi@toko.id" },
  ]);
  assert.deepEqual(parseAddressList("cc", undefined), []);
  assert.deepEqual(parseAddressList("cc", "  "), []);
});

const INVALID_LISTS = [
  ["line feed (header injection)", "budi@example.com\nBcc: victim@example.com"],
  ["carriage return", "budi@example.com\r"],
  ["unicode line separator", "budi@example.com x"],
  ["no domain", "budi@"],
  ["no TLD", "budi@localhost"],
  ["numeric TLD", "budi@10.0.0.1"],
  ["space in address", "bu di@example.com"],
  ["group syntax", "team: a@example.com, b@example.com;"],
  ["quote in name", 'Bu"di <budi@example.com>'],
  ["two @", "a@b@example.com"],
  ["leading dot", ".budi@example.com"],
  ["display name that looks like an address", '"ceo@bank.example.com" <evil@example.net>'],
  ["unquoted display name with @", "support@shop.example.com <evil@example.net>"],
];

for (const [caseName, rawList] of INVALID_LISTS) {
  test(`parseAddressList refuses ${caseName}`, () => {
    assert.throws(() => parseAddressList("to", rawList), { kind: "invalid_input" });
  });
}

test("isValidEmailAddress accepts plus tags, subdomains and IDN domains", () => {
  assert.equal(isValidEmailAddress("budi+toko@mail.example.co.id"), true);
  assert.equal(isValidEmailAddress("andi@bücher.de"), true);
  assert.equal(isValidEmailAddress(`${"a".repeat(65)}@example.com`), false);
});

test("assertSingleLine refuses CR, LF and NUL", () => {
  assert.equal(assertSingleLine("subject", "Halo"), "Halo");
  for (const badSubject of ["a\rb", "a\nb", "a\u0000b"]) assert.throws(() => assertSingleLine("subject", badSubject), { kind: "invalid_input" });
});

test("normalizeMessageId adds brackets and refuses junk", () => {
  assert.equal(normalizeMessageId("in_reply_to", "abc@mail.example.com"), "<abc@mail.example.com>");
  assert.equal(normalizeMessageId("in_reply_to", " <abc@mail.example.com> "), "<abc@mail.example.com>");
  assert.throws(() => normalizeMessageId("in_reply_to", "no-at-sign"), { kind: "invalid_input" });
  assert.throws(() => normalizeMessageId("in_reply_to", "<a@b>\r\nBcc: x@y.z"), { kind: "invalid_input" });
});

for (const controlCharacter of ["\u0001", "\u001b", "\u007f", "\t"]) {
  test(`normalizeMessageId refuses control character U+${controlCharacter.charCodeAt(0).toString(16).padStart(4, "0")}`, () => {
    assert.throws(() => normalizeMessageId("in_reply_to", `<ab${controlCharacter}c@mail.example.com>`), { kind: "invalid_input" });
    assert.throws(() => normalizeMessageId("in_reply_to", `<abc@mail${controlCharacter}.example.com>`), { kind: "invalid_input" });
  });
}

test("normalizeMessageIdList splits on whitespace", () => {
  assert.deepEqual(normalizeMessageIdList("references", "<a@x.com> <b@x.com>\t c@x.com"), ["<a@x.com>", "<b@x.com>", "<c@x.com>"]);
  assert.throws(() => normalizeMessageIdList("references", "<a@x.com> nope"), { kind: "invalid_input" });
});
