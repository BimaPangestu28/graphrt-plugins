import { test } from "node:test";
import assert from "node:assert/strict";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { buildSecretVariants, classifyImportError, createRedactor, redactError } from "../lib/errors.mjs";
import { requireImapSettings, requireSmtpSettings, resolveSettings } from "../lib/settings.mjs";

const PASSWORD = "abcd efgh ijkl mnop";
const USER = "budi@example.com";

test("the redactor hides the password, its space-less form and the AUTH PLAIN / LOGIN encodings", () => {
  const redact = createRedactor(buildSecretVariants({ user: USER, password: PASSWORD }));
  const plainToken = Buffer.from(`\u0000${USER}\u0000${PASSWORD}`).toString("base64");
  const loginToken = Buffer.from("abcdefghijklmnop").toString("base64");
  const leaked = `535 ${PASSWORD} / abcdefghijklmnop / AUTH PLAIN ${plainToken} / ${loginToken}`;
  const redacted = redact(leaked);
  for (const secret of [PASSWORD, "abcdefghijklmnop", plainToken, loginToken]) assert.ok(!redacted.includes(secret), secret);
  assert.match(redacted, /^535 \[redacted\]/);
});

test("the redactor hides the IMAP quoted-string form of a password with quotes or backslashes", () => {
  const quotingPassword = 'pa"ss\\word-123';
  const redact = createRedactor(buildSecretVariants({ user: USER, password: quotingPassword }));
  const imapEscaped = 'pa\\"ss\\\\word-123';
  const redacted = redact(`A1 LOGIN "${USER}" "${imapEscaped}" failed`);
  assert.ok(!redacted.includes(imapEscaped), redacted);
  assert.ok(!redacted.includes("word-123"), redacted);
});

test("redactError keeps kind and retryable, wraps foreign errors", () => {
  const redact = createRedactor(buildSecretVariants({ user: USER, password: PASSWORD }));
  const pluginError = redactError(new PluginError(`bad ${PASSWORD}`, { kind: "network_error", retryable: true }), redact);
  assert.deepEqual([pluginError.kind, pluginError.retryable, pluginError.message], ["network_error", true, "bad [redacted]"]);
  const foreignError = redactError(new TypeError(`x ${PASSWORD}`), redact);
  assert.equal(foreignError.kind, "plugin_error");
  assert.ok(!foreignError.message.includes(PASSWORD));
});

test("a missing package is setup_required", () => {
  assert.equal(classifyImportError("imapflow", Object.assign(new Error("Cannot find package 'imapflow'"), { code: "ERR_MODULE_NOT_FOUND" })).kind, "setup_required");
  const otherError = new Error("boom");
  assert.equal(classifyImportError("imapflow", otherError), otherError);
});

test("settings defaults: 465/993 with TLS, IMAP user and From fall back to the SMTP user", () => {
  const settings = resolveSettings({ HOME: "/home/budi", EMAIL_SMTP_HOST: "smtp.gmail.com", EMAIL_SMTP_USER: USER, EMAIL_IMAP_HOST: "imap.gmail.com" });
  assert.deepEqual(settings.smtp, { host: "smtp.gmail.com", port: 465, secure: true, user: USER });
  assert.deepEqual(settings.imap, { host: "imap.gmail.com", port: 993, secure: true, user: USER });
  assert.equal(settings.from, USER);
  assert.equal(settings.dailySendLimit, 200);
  assert.deepEqual(settings.allowedFileDirectories, []);
  assert.equal(settings.stateDirectory, "/home/budi/.graphrt/email");
});

test("settings overrides are parsed", () => {
  const settings = resolveSettings({
    HOME: "/home/budi",
    EMAIL_SMTP_HOST: "smtp-mail.outlook.com",
    EMAIL_SMTP_PORT: "587",
    EMAIL_SMTP_SECURE: "false",
    EMAIL_SMTP_USER: USER,
    EMAIL_IMAP_USER: "other@example.com",
    EMAIL_FROM: "Toko <toko@example.com>",
    EMAIL_DAILY_SEND_LIMIT: "0",
    EMAIL_ALLOWED_FILE_DIRS: "~/invoices, /srv/files",
  });
  assert.deepEqual(settings.smtp, { host: "smtp-mail.outlook.com", port: 587, secure: false, user: USER });
  assert.equal(settings.imap.user, "other@example.com");
  assert.equal(settings.from, "Toko <toko@example.com>");
  assert.equal(settings.dailySendLimit, 0);
  assert.deepEqual(settings.allowedFileDirectories, ["/home/budi/invoices", "/srv/files"]);
});

const INVALID_SETTINGS = [
  { EMAIL_SMTP_PORT: "70000" },
  { EMAIL_SMTP_PORT: "abc" },
  { EMAIL_SMTP_SECURE: "maybe" },
  { EMAIL_SMTP_HOST: "smtp.example.com/evil" },
  { EMAIL_DAILY_SEND_LIMIT: "-1" },
  { EMAIL_ALLOWED_FILE_DIRS: "relative/dir" },
  { EMAIL_FROM: "a@example.com\r\nBcc: x@example.com" },
];

for (const environment of INVALID_SETTINGS) {
  test(`settings refuse ${JSON.stringify(environment)}`, () => {
    assert.throws(() => resolveSettings(environment), { kind: "invalid_input" });
  });
}

test("EMAIL_TOOL_ALLOWED_RECIPIENTS: unset is null, entries are lowercased addresses and @domains", () => {
  assert.equal(resolveSettings({}).toolAllowedRecipients, null);
  assert.deepEqual(resolveSettings({ EMAIL_TOOL_ALLOWED_RECIPIENTS: " Sari@Example.com , @Toko.CO.id ,," }).toolAllowedRecipients, {
    addresses: ["sari@example.com"],
    domains: ["toko.co.id"],
  });
});

for (const badEntry of ["not-an-address", "@", "@localhost", "Sari <sari@example.com>", "*@example.com"]) {
  test(`EMAIL_TOOL_ALLOWED_RECIPIENTS refuses ${JSON.stringify(badEntry)}`, () => {
    assert.throws(() => resolveSettings({ EMAIL_TOOL_ALLOWED_RECIPIENTS: badEntry }), { kind: "invalid_input", message: /EMAIL_TOOL_ALLOWED_RECIPIENTS/ });
  });
}

test("requireSmtpSettings / requireImapSettings explain missing configuration", () => {
  const settings = resolveSettings({});
  assert.throws(() => requireSmtpSettings(settings), { kind: "setup_required", message: /EMAIL_SMTP_HOST/ });
  assert.throws(() => requireImapSettings(settings), { kind: "setup_required", message: /EMAIL_IMAP_HOST/ });
});
