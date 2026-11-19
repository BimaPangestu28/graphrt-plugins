import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMimeMessage, encodeRawMessage } from "../lib/mime-message.mjs";

test("a text-only message has the exact headers and a base64 body", () => {
  const { mime, recipients } = buildMimeMessage({ to: ["ada@example.com"], cc: ["bob@example.org"], bcc: ["eve@example.net"], subject: "Hi", text: "Hello" });
  assert.equal(
    mime,
    "To: ada@example.com\r\nCc: bob@example.org\r\nBcc: eve@example.net\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=",
  );
  assert.deepEqual(recipients, ["ada@example.com", "bob@example.org", "eve@example.net"]);
});

test("text plus html is multipart/alternative with a content-derived boundary", () => {
  const first = buildMimeMessage({ to: ["ada@example.com"], subject: "Hi", text: "Hello", html: "<b>Hello</b>" }).mime;
  const boundary = /boundary="(graphrt-alt-[0-9a-f]{24})"/.exec(first)[1];
  assert.equal(first, buildMimeMessage({ to: ["ada@example.com"], subject: "Hi", text: "Hello", html: "<b>Hello</b>" }).mime, "deterministic");
  assert.ok(first.includes(`\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8=\r\n`));
  assert.ok(first.includes(`\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nPGI+SGVsbG88L2I+\r\n--${boundary}--`));
});

test("non-ASCII subjects are RFC 2047 encoded; long bodies wrap at 76 characters", () => {
  const { mime } = buildMimeMessage({ to: ["ada@example.com"], subject: "Laporan bulanan ✓", text: "x".repeat(200) });
  assert.ok(mime.includes(`Subject: =?UTF-8?B?${Buffer.from("Laporan bulanan ✓").toString("base64")}?=\r\n`));
  const bodyLines = mime.split("\r\n\r\n")[1].split("\r\n");
  assert.ok(bodyLines.every((line) => line.length <= 76));
  assert.equal(Buffer.from(bodyLines.join(""), "base64").toString(), "x".repeat(200));
});

test("header injection is impossible: bad subjects, addresses and Message-IDs are refused", () => {
  const base = { to: ["ada@example.com"], subject: "Hi", text: "x" };
  const badInputs = [
    { subject: "Hi\r\nBcc: victim@example.com" },
    { subject: "Hi\nX: y" },
    { to: ["ada@example.com\r\nBcc: victim@example.com"] },
    { to: ["Ada <ada@example.com>"] },
    { cc: ["a@b.com, c@d.com"] },
    { in_reply_to: "<a@b>\r\nBcc: victim@example.com" },
    { in_reply_to: "not-a-message-id" },
    { text: undefined },
  ];
  for (const badInput of badInputs) assert.throws(() => buildMimeMessage({ ...base, ...badInput }), (error) => error.kind === "invalid_input", JSON.stringify(badInput));
});

test("addresses with control characters (NUL, DEL, other C0) are refused", () => {
  for (const controlCharacter of ["\u0000", "\u0001", "\u001f", "\u007f"]) {
    assert.throws(() => buildMimeMessage({ to: [`a${controlCharacter}b@example.com`], subject: "Hi", text: "x" }), (error) => error.kind === "invalid_input", JSON.stringify(controlCharacter));
  }
});

function decodeEncodedWords(headerValue) {
  return headerValue
    .split(/\r\n /)
    .map((encodedWord) => /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(encodedWord)[1])
    .reduce((bytes, base64Text) => Buffer.concat([bytes, Buffer.from(base64Text, "base64")]), Buffer.alloc(0))
    .toString("utf8");
}

test("long non-ASCII subjects fold into encoded-words of at most 75 characters on continuation lines", () => {
  for (const subject of ["é".repeat(400), "Laporan ✓ ".repeat(60), "😀".repeat(100)]) {
    const { mime } = buildMimeMessage({ to: ["ada@example.com"], subject, text: "x" });
    const headerBlock = mime.split("\r\n\r\n")[0];
    const subjectHeader = /\r\nSubject: ((?:[^\r]*)(?:\r\n [^\r]*)*)\r\nMIME-Version/.exec(headerBlock)[1];
    for (const encodedWord of subjectHeader.split("\r\n ")) assert.ok(encodedWord.length <= 75, `encoded-word of ${encodedWord.length} characters`);
    assert.ok(headerBlock.split("\r\n").every((line) => line.length <= 78), "every header line fits 78 characters");
    assert.equal(decodeEncodedWords(subjectHeader), subject, "no character is split across encoded-words");
  }
});

test("in_reply_to sets In-Reply-To and References for threading", () => {
  const { mime } = buildMimeMessage({ to: ["ada@example.com"], subject: "Re: Hi", text: "ok", in_reply_to: "<CAB123@mail.gmail.com>" });
  assert.ok(mime.includes("In-Reply-To: <CAB123@mail.gmail.com>\r\nReferences: <CAB123@mail.gmail.com>\r\n"));
});

test("raw is base64url without padding", () => {
  assert.equal(encodeRawMessage("Subject: ??>\r\n\r\nä"), Buffer.from("Subject: ??>\r\n\r\nä").toString("base64url"));
  assert.doesNotMatch(encodeRawMessage("Subject: ??>"), /[+/=]/);
});
