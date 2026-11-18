import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { TEST_PASSWORD, TEST_USER, withRunner } from "./helpers.mjs";

const SEND_ARGS = { to: "sari@example.com", subject: "Pesanan #12", text: "Halo Sari" };
const AS_NODE = { source: "node" };

test("manifest: every operation is a tool, password and settings env are declared, network allowed", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), [
    "verify_connection", "send_email", "list_messages", "read_message", "list_mailboxes", "mark_seen", "mark_unseen", "move_message",
  ]);
  for (const variableName of ["EMAIL_PASSWORD", "EMAIL_SMTP_HOST", "EMAIL_IMAP_HOST", "EMAIL_DAILY_SEND_LIMIT", "EMAIL_ALLOWED_FILE_DIRS", "EMAIL_STATE_DIR", "EMAIL_TOOL_ALLOWED_RECIPIENTS"]) {
    assert.ok(manifest.permissions.env.includes(variableName), variableName);
  }
  assert.equal(manifest.permissions.network, true);
  assert.ok(manifest.nodes.every((node) => node.config_schema.properties.access_token));
});

test("no password → auth_error before any connection", () =>
  withRunner({ environment: { EMAIL_PASSWORD: "" } }, async ({ runOperation, smtpFactory }) => {
    await assert.rejects(runOperation("send_email", SEND_ARGS), { kind: "auth_error", message: /EMAIL_PASSWORD/ });
    assert.equal(smtpFactory.transports.length, 0);
  }));

test("a node's access_token replaces EMAIL_PASSWORD", () =>
  withRunner({}, async ({ runOperation, smtpFactory }) => {
    await runOperation("verify_connection", { protocol: "smtp", access_token: "node-secret" }, { source: "node" });
    assert.equal(smtpFactory.transports[0].options.auth.pass, "node-secret");
  }));

test("send_email builds the message, counts recipients and reports the result", () =>
  withRunner({ environment: { EMAIL_FROM: "Toko Budi <budi@example.com>" } }, async ({ runOperation, smtpFactory, stateDirectory }) => {
    const output = await runOperation("send_email", {
      ...SEND_ARGS,
      cc: "Andi <andi@example.com>",
      bcc: "boss@example.com",
      html: "<p>Halo</p>",
      reply_to: "cs@example.com",
      in_reply_to: "orig-1@mail.example.com",
      references: "<root@mail.example.com> <orig-1@mail.example.com>",
    }, AS_NODE);
    const sentMessage = smtpFactory.transports[0].sentMessages[0];
    assert.deepEqual(sentMessage.from, { name: "Toko Budi", address: "budi@example.com" });
    assert.deepEqual(sentMessage.to, [{ name: "", address: "sari@example.com" }]);
    assert.deepEqual(sentMessage.cc, [{ name: "Andi", address: "andi@example.com" }]);
    assert.equal(sentMessage.subject, "Pesanan #12");
    assert.equal(sentMessage.inReplyTo, "<orig-1@mail.example.com>");
    assert.deepEqual(sentMessage.references, ["<root@mail.example.com>", "<orig-1@mail.example.com>"]);
    assert.equal(sentMessage.disableFileAccess, true);
    assert.equal(sentMessage.disableUrlAccess, true);
    assert.deepEqual(sentMessage.attachments, []);
    assert.equal(output.data.sent, true);
    assert.equal(output.data.message_id, "<new-1@example.com>");
    assert.deepEqual([output.data.sends_today, output.data.daily_limit], [3, 200]);
    assert.ok(smtpFactory.transports[0].closed);
    const [stateFileName] = await readdir(stateDirectory);
    assert.equal(stateFileName, "send-state-budi@example.com@smtp.example.com.json");
  }));

const SEND_VALIDATION_CASES = [
  [{ ...SEND_ARGS, subject: "Hi\r\nBcc: victim@example.com" }, "subject with CRLF"],
  [{ ...SEND_ARGS, to: "sari@example.com\nBcc: victim@example.com" }, "to with LF"],
  [{ ...SEND_ARGS, to: "not-an-address" }, "invalid address"],
  [{ ...SEND_ARGS, cc: "x@example.com" , to: ", ," }, "no to address"],
  [{ to: SEND_ARGS.to, subject: "x" }, "no body"],
  [{ ...SEND_ARGS, in_reply_to: "garbage" }, "bad in_reply_to"],
  [{ ...SEND_ARGS, to: Array.from({ length: 51 }, (unused, index) => `u${index}@example.com`).join(",") }, "51 recipients"],
  [{ ...SEND_ARGS, subject: "x".repeat(999) }, "long subject"],
  [{ ...SEND_ARGS, attachments: [{ source: "/etc/passwd" }] }, "local file without allowlist"],
];

for (const [args, caseName] of SEND_VALIDATION_CASES) {
  test(`send_email refuses ${caseName} without connecting or counting`, () =>
    withRunner({}, async ({ runOperation, smtpFactory, stateDirectory }) => {
      await assert.rejects(runOperation("send_email", args, AS_NODE), { kind: "invalid_input" });
      assert.equal(smtpFactory.transports.length, 0);
      assert.deepEqual(await readdir(stateDirectory), []);
    }));
}

test("send_email refuses over the daily cap without connecting", () =>
  withRunner({ environment: { EMAIL_DAILY_SEND_LIMIT: "2" } }, async ({ runOperation, smtpFactory }) => {
    await runOperation("send_email", { ...SEND_ARGS, cc: "a@example.com" }, AS_NODE);
    await assert.rejects(runOperation("send_email", SEND_ARGS, AS_NODE), { kind: "rate_limited", retryable: false });
    assert.equal(smtpFactory.transports.length, 1);
  }));

test("send_email fails closed on a corrupt counter file", () =>
  withRunner({}, async ({ runOperation, smtpFactory, stateDirectory }) => {
    await writeFile(join(stateDirectory, "send-state-budi@example.com@smtp.example.com.json"), "garbage");
    await assert.rejects(runOperation("send_email", SEND_ARGS, AS_NODE), { kind: "rate_limited", message: /cannot be used/ });
    assert.equal(smtpFactory.transports.length, 0);
  }));

test("send failures are never retryable and never leak the password", () =>
  withRunner(
    { smtpOverrides: { sendMail: () => Promise.reject(Object.assign(new Error(`Connection closed (pass ${TEST_PASSWORD})`), { code: "ECONNECTION", command: "DATA" })) } },
    async ({ runOperation, stateDirectory }) => {
      await assert.rejects(runOperation("send_email", SEND_ARGS, AS_NODE), (error) => {
        assert.equal(error.kind, "network_error");
        assert.equal(error.retryable, false);
        assert.match(error.message, /may or may not have been sent/);
        assert.ok(!error.message.includes(TEST_PASSWORD) && !error.message.includes("abcdefghijklmnop"));
        return true;
      });
      const [stateFileName] = await readdir(stateDirectory);
      assert.equal(JSON.parse(await readFile(join(stateDirectory, stateFileName), "utf8")).count, 1, "the attempt counts");
    },
  ));

test("agent tool calls cannot send_email until EMAIL_TOOL_ALLOWED_RECIPIENTS is set", () =>
  withRunner({}, async ({ runOperation, smtpFactory, stateDirectory }) => {
    await assert.rejects(runOperation("send_email", SEND_ARGS, { source: "tool" }), {
      kind: "permission_denied",
      retryable: false,
      message: /EMAIL_TOOL_ALLOWED_RECIPIENTS/,
    });
    assert.equal(smtpFactory.transports.length, 0);
    assert.deepEqual(await readdir(stateDirectory), [], "nothing counted");
  }));

const TOOL_ALLOWLIST = { EMAIL_TOOL_ALLOWED_RECIPIENTS: "Sari@Example.com, @Partner.example.org" };

test("agent tool calls may send to allowlisted addresses and @domains, case-insensitively", () =>
  withRunner({ environment: TOOL_ALLOWLIST }, async ({ runOperation, smtpFactory }) => {
    const output = await runOperation("send_email", { ...SEND_ARGS, to: "SARI@example.COM", cc: "andi@partner.EXAMPLE.org", bcc: "Budi <budi@partner.example.org>" }, { source: "tool" });
    assert.equal(output.data.sent, true);
    assert.equal(smtpFactory.transports[0].sentMessages.length, 1);
  }));

for (const [fieldName, address] of [["to", "boss@example.com"], ["cc", "x@sub.partner.example.org"], ["bcc", "spy@evil.example.net"]]) {
  test(`agent tool calls refuse a ${fieldName} recipient outside the allowlist (${address})`, () =>
    withRunner({ environment: TOOL_ALLOWLIST }, async ({ runOperation, smtpFactory }) => {
      await assert.rejects(runOperation("send_email", { ...SEND_ARGS, [fieldName]: address }, { source: "tool" }), (error) => {
        assert.equal(error.kind, "permission_denied");
        assert.ok(error.message.includes(address), error.message);
        assert.match(error.message, /Nothing was sent/);
        return true;
      });
      assert.equal(smtpFactory.transports.length, 0);
    }));
}

test("agent tool calls cannot attach files or URLs; nothing is read or downloaded", () => {
  const fetchImpl = async () => assert.fail("no download for a refused tool call");
  return withRunner({ environment: TOOL_ALLOWLIST, fetchImpl }, async ({ runOperation, smtpFactory }) => {
    for (const source of ["https://files.example.com/a.pdf", "/etc/passwd"]) {
      await assert.rejects(runOperation("send_email", { ...SEND_ARGS, attachments: [{ source }] }, { source: "tool" }), { kind: "permission_denied", message: /workflow node/ });
    }
    assert.equal(smtpFactory.transports.length, 0);
  });
});

test("workflow nodes are not limited by the agent recipient allowlist and may attach URLs", () => {
  const fetchImpl = async () => ({ status: 200, ok: true, headers: new Headers(), body: [Buffer.from("PDF")] });
  const resolveHostAddresses = async () => ["93.184.216.34"];
  return withRunner({ environment: TOOL_ALLOWLIST, fetchImpl, resolveHostAddresses }, async ({ runOperation, smtpFactory }) => {
    await runOperation("send_email", { ...SEND_ARGS, to: "anyone@elsewhere.example.net", attachments: [{ source: "https://files.example.com/a.pdf" }] }, AS_NODE);
    const [attachment] = smtpFactory.transports[0].sentMessages[0].attachments;
    assert.deepEqual([attachment.filename, attachment.content.toString()], ["a.pdf", "PDF"]);
  });
});

test("verify_connection checks configured servers only and sends nothing", () =>
  withRunner({ environment: { EMAIL_IMAP_HOST: "" } }, async ({ runOperation, smtpFactory, imapFactory }) => {
    const output = await runOperation("verify_connection", {});
    assert.equal(output.data.smtp.ok, true);
    assert.match(output.data.imap.skipped, /EMAIL_IMAP_HOST/);
    assert.equal(smtpFactory.transports[0].sentMessages.length, 0);
    assert.equal(imapFactory.clients.length, 0);
    await assert.rejects(runOperation("verify_connection", { protocol: "imap" }), { kind: "setup_required" });
  }));

test("verify_connection maps an SMTP auth failure to auth_error", () =>
  withRunner({ smtpOverrides: { verify: () => Promise.reject(Object.assign(new Error("Invalid login: 535 5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 })) } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("verify_connection", { protocol: "smtp" }), { kind: "auth_error" });
  }));

test("verify_connection imap logs in and out", () =>
  withRunner({}, async ({ runOperation, imapFactory }) => {
    const output = await runOperation("verify_connection", { protocol: "imap" });
    assert.equal(output.data.imap.ok, true);
    assert.equal(imapFactory.clients[0].loggedOut, true);
    assert.equal(imapFactory.clients[0].options.auth.pass, TEST_PASSWORD);
  }));

const MESSAGES = {
  10: { envelope: { subject: "Lama", from: [{ name: "A", address: "a@example.com" }], date: new Date("2026-11-01T00:00:00Z") }, bodyStructure: { type: "text/plain" }, parts: { 1: "old body" } },
  11: {
    envelope: { subject: "Promo\r\nX-Evil: 1", from: [{ name: "Toko", address: "promo@example.com" }], date: new Date("2026-11-10T00:00:00Z"), messageId: "<p11@example.com>" },
    flags: ["\\Seen"],
    bodyStructure: { type: "multipart/alternative", childNodes: [{ part: "1", type: "text/html" }] },
    parts: { 1: "<style>x{}</style><p>Diskon <b>50%</b></p><script>steal()</script>" },
  },
  12: {
    envelope: { subject: "Invoice", from: [{ name: "Sari", address: "sari@example.com" }], to: [{ name: "", address: TEST_USER }], date: new Date("2026-11-17T00:00:00Z"), messageId: "<i12@example.com>", inReplyTo: "<i11@example.com>" },
    headers: Buffer.from("References: <root@example.com>\r\n <i11@example.com>\r\n\r\n"),
    bodyStructure: {
      type: "multipart/mixed",
      childNodes: [
        { type: "multipart/alternative", childNodes: [{ part: "1.1", type: "text/plain" }, { part: "1.2", type: "text/html" }] },
        { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "inv.pdf" }, encoding: "base64", size: 400 },
      ],
    },
    parts: { "1.1": "Terlampir invoice.\r\nTerima kasih", "1.2": "<p>html</p>" },
  },
};

test("list_messages: newest first, read-only, snippets with HTML converted, cursor paging", () =>
  withRunner({ imapState: { messages: MESSAGES } }, async ({ runOperation, imapFactory }) => {
    const firstPage = await runOperation("list_messages", { limit: 2 });
    assert.deepEqual(firstPage.data.messages.map((message) => message.uid), [12, 11]);
    assert.equal(firstPage.next_cursor, "777:11");
    assert.equal(firstPage.data.messages[1].snippet, "Diskon 50%");
    assert.equal(firstPage.data.messages[1].subject, "Promo X-Evil: 1", "header text loses its line breaks");
    assert.equal(firstPage.data.messages[0].has_attachments, true);
    const client = imapFactory.clients[0];
    assert.deepEqual(client.calls.find((call) => call[0] === "lock"), ["lock", "INBOX", { readOnly: true }]);
    assert.deepEqual(client.calls.find((call) => call[0] === "search").slice(1), [{ all: true }, { uid: true }]);
    assert.ok(client.loggedOut);
    const secondPage = await runOperation("list_messages", { limit: 2, cursor: firstPage.next_cursor });
    assert.deepEqual(secondPage.data.messages.map((message) => message.uid), [10]);
    assert.equal(secondPage.next_cursor, null);
  }));

test("list_messages passes filters to the IMAP search", () =>
  withRunner({ imapState: { messages: {} } }, async ({ runOperation, imapFactory }) => {
    await runOperation("list_messages", { unseen_only: true, since: "2026-11-01", from: "sari", subject: "invoice", mailbox: "Arsip" });
    const client = imapFactory.clients[0];
    const [, searchQuery] = client.calls.find((call) => call[0] === "search");
    assert.deepEqual(searchQuery, { seen: false, since: new Date("2026-11-01T00:00:00Z"), from: "sari", subject: "invoice" });
    assert.equal(client.calls.find((call) => call[0] === "lock")[1], "Arsip");
  }));

const LIST_VALIDATION_CASES = [
  { since: "kemarin" },
  { from: "a\r\nb" },
  { cursor: "abc" },
  { cursor: "999:5" },
  { mailbox: "IN\u0000BOX" },
  { limit: 51 },
];

for (const args of LIST_VALIDATION_CASES) {
  test(`list_messages refuses ${JSON.stringify(args)}`, () =>
    withRunner({ imapState: { messages: MESSAGES } }, async ({ runOperation }) => {
      await assert.rejects(runOperation("list_messages", args), { kind: "invalid_input" });
    }));
}

test("list_messages on a missing mailbox is not_found", () =>
  withRunner({ imapState: { missingMailboxes: ["Nope"] } }, async ({ runOperation, imapFactory }) => {
    await assert.rejects(runOperation("list_messages", { mailbox: "Nope" }), { kind: "not_found" });
    assert.ok(imapFactory.clients[0].loggedOut);
  }));

test("read_message returns plain text, threading headers and attachment metadata without marking seen", () =>
  withRunner({ imapState: { messages: MESSAGES } }, async ({ runOperation, imapFactory }) => {
    const { data } = await runOperation("read_message", { uid: 12 });
    assert.equal(data.text, "Terlampir invoice.\nTerima kasih");
    assert.equal(data.text_format, "plain");
    assert.equal(data.message_id, "<i12@example.com>");
    assert.equal(data.in_reply_to, "<i11@example.com>");
    assert.deepEqual(data.references, ["<root@example.com>", "<i11@example.com>"]);
    assert.deepEqual(data.attachments, [{ part: "2", filename: "inv.pdf", content_type: "application/pdf", size_bytes: 300, disposition: "attachment", content_id: null }]);
    const client = imapFactory.clients[0];
    assert.deepEqual(client.calls.find((call) => call[0] === "lock")[2], { readOnly: true });
    assert.ok(!client.calls.some((call) => call[0] === "flagsAdd"));
    assert.ok(!client.calls.some((call) => call[0] === "download" && call[2] === "2"), "attachments are never downloaded");
  }));

test("read_message converts HTML-only bodies and caps the text", () =>
  withRunner({ imapState: { messages: MESSAGES } }, async ({ runOperation }) => {
    const { data } = await runOperation("read_message", { uid: 11, max_text_chars: 100 });
    assert.equal(data.text, "Diskon 50%");
    assert.equal(data.text_format, "html_converted");
    const capped = await runOperation("read_message", { uid: 12, max_text_chars: 100 });
    assert.equal(capped.data.truncated, false);
  }));

test("read_message mark_seen selects read-write and sets \\Seen", () =>
  withRunner({ imapState: { messages: MESSAGES } }, async ({ runOperation, imapFactory }) => {
    const { data } = await runOperation("read_message", { uid: 10, mark_seen: true });
    const client = imapFactory.clients[0];
    assert.deepEqual(client.calls.find((call) => call[0] === "lock")[2], { readOnly: false });
    assert.deepEqual(client.calls.find((call) => call[0] === "flagsAdd").slice(1), ["10", ["\\Seen"], { uid: true }]);
    assert.ok(data.flags.includes("\\Seen"));
  }));

test("read_message of an unknown uid is not_found", () =>
  withRunner({ imapState: { messages: MESSAGES } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("read_message", { uid: 99 }), { kind: "not_found" });
  }));

test("mark_seen / mark_unseen change the \\Seen flag on the listed UIDs", () =>
  withRunner({}, async ({ runOperation, imapFactory }) => {
    await runOperation("mark_seen", { uids: "12, 11,12" });
    await runOperation("mark_unseen", { uids: "5", mailbox: "Arsip" });
    assert.deepEqual(imapFactory.clients[0].calls.find((call) => call[0] === "flagsAdd").slice(1), ["12,11", ["\\Seen"], { uid: true }]);
    assert.deepEqual(imapFactory.clients[1].calls.find((call) => call[0] === "flagsRemove").slice(1), ["5", ["\\Seen"], { uid: true }]);
    assert.deepEqual(imapFactory.clients[1].calls.find((call) => call[0] === "lock"), ["lock", "Arsip", { readOnly: false }]);
  }));

for (const uids of ["", "abc", "0", "1,,x", Array.from({ length: 101 }, (unused, index) => index + 1).join(",")]) {
  test(`mark_seen refuses uids ${JSON.stringify(uids.slice(0, 20))}`, () =>
    withRunner({}, async ({ runOperation }) => {
      await assert.rejects(runOperation("mark_seen", { uids }), { kind: "invalid_input" });
    }));
}

test("flag changes that fail on the network are not retryable", () =>
  withRunner({ imapState: { flagError: Object.assign(new Error("closed"), { code: "EConnectionClosed" }) } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("mark_seen", { uids: "1" }), { kind: "network_error", retryable: false });
  }));

test("move_message moves and reports the new UIDs", () =>
  withRunner({}, async ({ runOperation, imapFactory }) => {
    const { data } = await runOperation("move_message", { uids: "3,4", destination: "Arsip" });
    assert.deepEqual(imapFactory.clients[0].calls.find((call) => call[0] === "move").slice(1), ["3,4", "Arsip", { uid: true }]);
    assert.deepEqual(data.new_uids, { 3: 500, 4: 501 });
    assert.equal(data.moved_count, 2);
    await assert.rejects(runOperation("move_message", { uids: "3", destination: "INBOX" }), { kind: "invalid_input" });
  }));

test("move_message that imapflow reports as failed (false) has an unknown, non-retryable outcome", () =>
  withRunner({ imapState: { moveResult: false } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("move_message", { uids: "3", destination: "Nope" }), {
      kind: "api_error",
      retryable: false,
      message: /may or may not have been moved/,
    });
  }));

test("move_message refuses servers without MOVE or UIDPLUS (the fallback EXPUNGE could delete other messages)", () =>
  withRunner({ imapState: { capabilities: ["IMAP4rev1"] } }, async ({ runOperation, imapFactory }) => {
    await assert.rejects(runOperation("move_message", { uids: "3", destination: "Arsip" }), { kind: "invalid_input", message: /MOVE.*UIDPLUS|UIDPLUS.*MOVE/ });
    assert.ok(!imapFactory.clients[0].calls.some((call) => call[0] === "move"));
  }));

test("move_message works on a server with UIDPLUS but no MOVE", () =>
  withRunner({ imapState: { capabilities: ["IMAP4rev1", "UIDPLUS"] } }, async ({ runOperation }) => {
    const { data } = await runOperation("move_message", { uids: "3", destination: "Arsip" });
    assert.equal(data.moved, true);
  }));

test("move_message skips UIDs that do not exist and says so; none existing is not_found", () =>
  withRunner({ imapState: { existingUids: [3] } }, async ({ runOperation, imapFactory }) => {
    const { data } = await runOperation("move_message", { uids: "3,9", destination: "Arsip" });
    assert.deepEqual(imapFactory.clients[0].calls.find((call) => call[0] === "move").slice(1, 2), ["3"]);
    assert.deepEqual([data.uids, data.missing_uids], [[3], [9]]);
    await assert.rejects(runOperation("move_message", { uids: "8,9", destination: "Arsip" }), { kind: "not_found", message: /nothing was moved/i });
    assert.ok(!imapFactory.clients[1].calls.some((call) => call[0] === "move"));
  }));

for (const operationName of ["mark_seen", "mark_unseen"]) {
  test(`${operationName} that imapflow reports as failed (false) is a non-retryable api_error`, () =>
    withRunner({ imapState: { flagResult: false } }, async ({ runOperation }) => {
      await assert.rejects(runOperation(operationName, { uids: "1" }), { kind: "api_error", retryable: false, message: /may or may not have been applied/ });
    }));
}

test("mark_seen skips UIDs that do not exist and says so; none existing is not_found", () =>
  withRunner({ imapState: { existingUids: [12] } }, async ({ runOperation, imapFactory }) => {
    const { data } = await runOperation("mark_seen", { uids: "12,13" });
    assert.deepEqual(imapFactory.clients[0].calls.find((call) => call[0] === "flagsAdd").slice(1, 2), ["12"]);
    assert.deepEqual([data.uids, data.missing_uids], [[12], [13]]);
    await assert.rejects(runOperation("mark_seen", { uids: "13" }), { kind: "not_found", message: /nothing was changed/i });
    assert.ok(!imapFactory.clients[1].calls.some((call) => call[0] === "flagsAdd"));
  }));

test("read_message mark_seen that imapflow reports as failed (false) is a non-retryable api_error", () =>
  withRunner({ imapState: { messages: MESSAGES, flagResult: false } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("read_message", { uid: 10, mark_seen: true }), { kind: "api_error", retryable: false, message: /may or may not have been applied/ });
  }));

test("list_mailboxes shapes entries and asks for counts only when requested", () =>
  withRunner(
    { imapState: { mailboxes: [{ path: "[Gmail]/Sent Mail", name: "Sent Mail", delimiter: "/", specialUse: "\\Sent", flags: new Set(["\\Sent"]), subscribed: true, status: { messages: 9, unseen: 1 } }] } },
    async ({ runOperation, imapFactory }) => {
      const { data } = await runOperation("list_mailboxes", { include_counts: true });
      assert.deepEqual(data.mailboxes, [{ path: "[Gmail]/Sent Mail", name: "Sent Mail", delimiter: "/", special_use: "\\Sent", flags: ["\\Sent"], subscribed: true, messages: 9, unseen: 1 }]);
      assert.deepEqual(imapFactory.clients[0].calls.find((call) => call[0] === "list")[1], { statusQuery: { messages: true, unseen: true } });
    },
  ));

test("IMAP auth failures surface as auth_error with the password redacted", () =>
  withRunner(
    { imapState: { connectError: Object.assign(new Error(`AUTHENTICATE failed for ${TEST_PASSWORD}`), { authenticationFailed: true }) } },
    async ({ runOperation }) => {
      await assert.rejects(runOperation("list_mailboxes", {}), (error) => {
        assert.equal(error.kind, "auth_error");
        assert.ok(!error.message.includes(TEST_PASSWORD));
        return true;
      });
    },
  ));
