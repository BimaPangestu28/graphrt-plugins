/**
 * Filing documents into folders, and running numbers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueNextNumber, readNumberDate, resolveNumberPattern } from "../lib/number-sequence.mjs";
import { assertIfExistsAllowed, buildFilingTokens, createOutputOrganiser, resolveFilingPlan, toSafeSegment } from "../lib/output-organiser.mjs";
import { FIXED_NOW } from "./helpers.mjs";

const MEBIBYTE = 1024 * 1024;

async function withOutputDirectory(work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-document-filing-")));
  const outputDirectory = join(baseDirectory, "out");
  await mkdir(outputDirectory);
  try {
    return await work({ baseDirectory, outputDirectory, organiser: createOutputOrganiser({ outputDirectory, maxOutputBytes: MEBIBYTE }) });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

function plan(parameters, values = { number: "INV-2026-0007", date: "2026-03-05", client: { name: "PT Maju Bersama" } }) {
  return resolveFilingPlan({ extension: "pdf", ...parameters, filing: buildFilingTokens({ values, templateName: "invoice", now: FIXED_NOW }) });
}

test("names: any text becomes one safe file name", () => {
  const cases = [
    ["PT Maju/Jaya: Tbk.", "PT Maju-Jaya- Tbk"],
    ["../../etc/passwd", "etc-passwd"],
    ["..", ""],
    ["  spaced   out  ", "spaced out"],
    ["a\\b|c?d*e<f>g\"h", "a-b-c-d-e-f-g-h"],
    ["line\nbreak\u0000nul", "line-break-nul"],
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["株式会社 Ünïcode", "株式会社 Ünïcode"],
    ["x".repeat(200), "x".repeat(80)],
    [null, ""],
  ];
  for (const [input, expected] of cases) assert.equal(toSafeSegment(input), expected, JSON.stringify(input));
});

test("filing plan: defaults to year/month and the number; tokens come from the values", () => {
  assert.deepEqual(plan({}), { folderSegments: ["2026", "03"], fileStem: "INV-2026-0007", extension: "pdf" });
  assert.deepEqual(plan({ folder: "Invoices/{client}/{YYYY}", fileName: "{YYYY}{MM}{DD} {number} {values.client.name}" }), { folderSegments: ["Invoices", "PT Maju Bersama", "2026"], fileStem: "20260305 INV-2026-0007 PT Maju Bersama", extension: "pdf" });
  assert.deepEqual(plan({ folder: "/" }).folderSegments, []);
  assert.deepEqual(plan({}, {}), { folderSegments: ["2026", "11"], fileStem: "invoice-20261127-093015", extension: "pdf" });
  assert.deepEqual(plan({}, { number: "001/INV/XI/2026" }).fileStem, "001-INV-XI-2026");
});

test("filing plan: values can never add a folder level or leave the output directory", () => {
  const hostile = { number: "../../../etc/cron.d/job", date: "2026-03-05", client: { name: "..\\..\\evil/sub" } };
  assert.deepEqual(plan({ folder: "{client}/{YYYY}" }, hostile), { folderSegments: ["evil-sub", "2026"], fileStem: "etc-cron.d-job", extension: "pdf" });
  const refused = [{ folder: "../up" }, { folder: "a/./b" }, { folder: "{nope}" }, { folder: "{client" }, { fileName: "a/b" }, { fileName: "{values.missing}" }, { fileName: "{values.client}" }, { folder: "a/b/c/d/e/f/g" }, { fileName: " . " }];
  for (const parameters of refused) assert.throws(() => plan(parameters), { kind: "invalid_input" }, JSON.stringify(parameters));
  assert.throws(() => plan({ folder: "{client}" }, { number: "1" }), /\{client\}/);
});

test("saving: creates the folders, never replaces a file, numbers copies on request", () =>
  withOutputDirectory(async ({ outputDirectory, organiser }) => {
    const first = await organiser.saveDocument({ plan: plan({}), bytes: Buffer.from("one"), ifExists: "error" });
    assert.deepEqual(first, { path: join(outputDirectory, "2026", "03", "INV-2026-0007.pdf"), relative_path: "2026/03/INV-2026-0007.pdf", folder: "2026/03", file_name: "INV-2026-0007.pdf", size_bytes: 3, replaced_existing: false });
    await assert.rejects(organiser.saveDocument({ plan: plan({}), bytes: Buffer.from("two"), ifExists: "error" }), (error) => error.kind === "invalid_input" && /already exists; nothing was saved/.test(error.message));
    await assert.rejects(organiser.assertCanSave({ plan: plan({}), ifExists: "error" }), /already exists/);
    await organiser.assertCanSave({ plan: plan({}), ifExists: "number" });
    await organiser.assertCanSave({ plan: plan({ fileName: "free" }), ifExists: "error" });
    assert.equal(await readFile(first.path, "utf8"), "one");
    const copy = await organiser.saveDocument({ plan: plan({}), bytes: Buffer.from("two"), ifExists: "number" });
    assert.equal(copy.file_name, "INV-2026-0007-2.pdf");
    assert.equal((await organiser.saveDocument({ plan: plan({}), bytes: Buffer.from("three"), ifExists: "number" })).file_name, "INV-2026-0007-3.pdf");
    assert.deepEqual((await readdir(join(outputDirectory, "2026", "03"))).sort(), ["INV-2026-0007-2.pdf", "INV-2026-0007-3.pdf", "INV-2026-0007.pdf"]);
  }));

test("saving: overwrite replaces a plain file only, and only for nodes", () =>
  withOutputDirectory(async ({ baseDirectory, outputDirectory, organiser }) => {
    assert.throws(() => assertIfExistsAllowed("overwrite", "tool"), { kind: "permission_denied" });
    assert.throws(() => assertIfExistsAllowed("overwrite", undefined), { kind: "permission_denied" });
    assert.doesNotThrow(() => assertIfExistsAllowed("overwrite", "node"));
    assert.doesNotThrow(() => assertIfExistsAllowed("number", "tool"));
    const rootPlan = plan({ folder: "/" });
    await organiser.saveDocument({ plan: rootPlan, bytes: Buffer.from("old"), ifExists: "error" });
    const replaced = await organiser.saveDocument({ plan: rootPlan, bytes: Buffer.from("new"), ifExists: "overwrite" });
    assert.equal(replaced.replaced_existing, true);
    assert.equal(await readFile(replaced.path, "utf8"), "new");
    const outsideFile = join(baseDirectory, "outside.txt");
    await writeFile(outsideFile, "precious");
    await symlink(outsideFile, join(outputDirectory, "linked.pdf"));
    await link(outsideFile, join(outputDirectory, "hard.pdf"));
    for (const fileName of ["linked", "hard"]) {
      await assert.rejects(organiser.saveDocument({ plan: plan({ folder: "/", fileName }), bytes: Buffer.from("x"), ifExists: "overwrite" }), { kind: "invalid_input" }, fileName);
    }
    assert.equal(await readFile(outsideFile, "utf8"), "precious");
    assert.deepEqual((await readdir(outputDirectory)).filter((name) => name.endsWith(".partial")), []);
  }));

test("saving: a folder that is a link out of the output directory is refused; size cap and setup are checked", () =>
  withOutputDirectory(async ({ baseDirectory, outputDirectory, organiser }) => {
    await mkdir(join(baseDirectory, "elsewhere"));
    await symlink(join(baseDirectory, "elsewhere"), join(outputDirectory, "2026"));
    await assert.rejects(organiser.saveDocument({ plan: plan({}), bytes: Buffer.from("x"), ifExists: "error" }), (error) => error.kind === "invalid_input" && /leads outside/.test(error.message));
    assert.deepEqual(await readdir(join(baseDirectory, "elsewhere")), []);
    await assert.rejects(organiser.saveDocument({ plan: plan({ folder: "ok" }), bytes: Buffer.alloc(MEBIBYTE + 1), ifExists: "error" }), /over the 1048576-byte limit/);
    await assert.rejects(createOutputOrganiser({ outputDirectory: null, maxOutputBytes: 1 }).resolveOutputRoot(), { kind: "setup_required" });
    await assert.rejects(createOutputOrganiser({ outputDirectory: join(baseDirectory, "missing"), maxOutputBytes: 1 }).resolveOutputRoot(), { kind: "setup_required" });
  }));

test("number patterns: date tokens name the counter, {SEQ} is padded", () => {
  const date = new Date(Date.UTC(2026, 10, 27));
  assert.equal(resolveNumberPattern("INV-{YYYY}-{SEQ:4}", date).format(42), "INV-2026-0042");
  assert.equal(resolveNumberPattern("INV-{YYYY}-{SEQ:4}", date).counterName, "INV-2026-{SEQ:4}");
  assert.equal(resolveNumberPattern("{SEQ:3}/INV/{ROMAN}/{YYYY}", date).format(7), "007/INV/XI/2026");
  assert.equal(resolveNumberPattern("Q{YY}{MM}{DD}#{SEQ}", date).format(12345), "Q261127#12345");
  for (const badPattern of ["INV-{YYYY}", "{SEQ}{SEQ}", "", "INV-{SEQ}-<b>", "{SEQ}-{WEEK}", "x".repeat(61) + "{SEQ}", 5]) assert.throws(() => resolveNumberPattern(badPattern, date), { kind: "invalid_input" }, String(badPattern));
  assert.equal(readNumberDate(undefined, FIXED_NOW).toISOString(), "2026-11-27T00:00:00.000Z");
  assert.equal(readNumberDate("2027-01-02", FIXED_NOW).toISOString(), "2027-01-02T00:00:00.000Z");
  assert.throws(() => readNumberDate("next week", FIXED_NOW), { kind: "invalid_input" });
});

test("numbering: counts per counter, previews without reserving, starts where asked, restarts with the year", () =>
  withOutputDirectory(async ({ outputDirectory }) => {
    const issue = (overrides = {}) => issueNextNumber(outputDirectory, { pattern: "INV-{YYYY}-{SEQ:4}", date: new Date(Date.UTC(2026, 10, 27)), startAt: 1, isPreview: false, ...overrides });
    assert.deepEqual(await issue({ isPreview: true }), { number: "INV-2026-0001", sequence: 1, counter: "INV-2026-{SEQ:4}", reserved: false });
    assert.deepEqual(await readdir(outputDirectory), []);
    assert.equal((await issue()).number, "INV-2026-0001");
    assert.equal((await issue({ isPreview: true })).number, "INV-2026-0002");
    assert.equal((await issue({ startAt: 500 })).number, "INV-2026-0002");
    assert.equal((await issue({ date: new Date(Date.UTC(2027, 0, 2)) })).number, "INV-2027-0001");
    assert.equal((await issue({ pattern: "QUO-{SEQ:3}", startAt: 38 })).number, "QUO-038");
    const state = JSON.parse(await readFile(join(outputDirectory, ".document-templates", "numbering.json"), "utf8"));
    assert.deepEqual(Object.fromEntries(Object.entries(state.counters).map(([name, counter]) => [name, counter.last])), { "INV-2026-{SEQ:4}": 2, "INV-2027-{SEQ:4}": 1, "QUO-{SEQ:3}": 38 });
  }));

test("numbering: calls at the same time never share a number; a stale lock is taken over; a damaged file is reported", () =>
  withOutputDirectory(async ({ outputDirectory }) => {
    const request = { pattern: "INV-{SEQ}", date: new Date(Date.UTC(2026, 0, 1)), startAt: 1, isPreview: false };
    const issued = await Promise.all(Array.from({ length: 25 }, () => issueNextNumber(outputDirectory, request)));
    assert.deepEqual(issued.map((result) => result.sequence).sort((left, right) => left - right), Array.from({ length: 25 }, (_unused, index) => index + 1));
    const lockPath = join(outputDirectory, ".document-templates", "numbering.lock");
    await writeFile(lockPath, "");
    const longAgo = new Date(Date.now() - 120000);
    await utimes(lockPath, longAgo, longAgo);
    assert.equal((await issueNextNumber(outputDirectory, request)).sequence, 26);
    await writeFile(lockPath, "");
    let clock = Date.now();
    await assert.rejects(issueNextNumber(outputDirectory, request, { now: () => new Date((clock += 2000)), sleep: async () => {} }), (error) => error.kind === "plugin_error" && /try again/.test(error.message));
    await rm(lockPath);
    await writeFile(join(outputDirectory, ".document-templates", "numbering.json"), "{ not json");
    await assert.rejects(issueNextNumber(outputDirectory, request), (error) => error.kind === "invalid_input" && /damaged/.test(error.message));
    await assert.rejects(issueNextNumber(outputDirectory, { ...request, isPreview: true }), /damaged/);
  }));
