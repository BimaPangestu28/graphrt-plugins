import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { buildColumnNames, escapeFormulaTrigger, normalizeRowsForWriting, parseA1Range, shapeRows, toPlainCellValue, typeNumericText } from "../lib/table-values.mjs";
import { detectDelimiter } from "../lib/table-io.mjs";
import { assertZipWithinLimits } from "../lib/zip-inspection.mjs";
import { AS_NODE, AS_TOOL, Excel, SKIP_WITHOUT_LIBRARIES, withTableRunner, writeTestWorkbook } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES };

test("manifest: local only, no secrets, four tools, row and unzip caps declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["list_sheets", "read", "write", "convert"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  for (const variableName of ["EXCEL_CSV_INPUT_DIRS", "EXCEL_CSV_OUTPUT_DIR", "EXCEL_CSV_MAX_ROWS", "EXCEL_CSV_MAX_UNZIPPED_BYTES"]) assert.ok(manifest.permissions.env.includes(variableName));
});

test("A1 ranges, cell values, header names and row shaping", () => {
  assert.deepEqual(parseA1Range("b2:$D$20"), { firstRow: 2, lastRow: 20, firstColumn: 2, lastColumn: 4 });
  assert.deepEqual(parseA1Range("AA1"), { firstRow: 1, lastRow: 1, firstColumn: 27, lastColumn: 27 });
  for (const badRange of ["D2:B1", "A0:B2", "1A:B2", "ZZZZ1", "XFE1", "A1:B2:C3"]) assert.throws(() => parseA1Range(badRange), { kind: "invalid_input" }, badRange);
  assert.equal(toPlainCellValue({ formula: "A1+1", result: 3 }), 3);
  assert.equal(toPlainCellValue({ sharedFormula: "A1", result: undefined }), null);
  assert.equal(toPlainCellValue({ richText: [{ text: "a" }, { text: "b" }] }), "ab");
  assert.equal(toPlainCellValue({ text: "site", hyperlink: "https://x" }), "site");
  assert.equal(toPlainCellValue({ error: "#N/A" }), "#N/A");
  assert.equal(toPlainCellValue(new Date(Date.UTC(2026, 0, 2))), "2026-01-02T00:00:00.000Z");
  assert.deepEqual(buildColumnNames(["name", "", "name", null], 5), ["name", "column_2", "name_2", "column_4", "column_5"]);
  const shaped = shapeRows([["a", "b"], [1, 2], [3]], { headerRow: 1, maxRows: 1, rowShape: "objects" });
  assert.deepEqual(shaped, { columns: ["a", "b"], rows: [{ a: 1, b: 2 }], row_count: 1, truncated: true });
});

test("CSV injection escaping, number typing and row normalisation", () => {
  for (const dangerous of ["=1+1", "+1+1", "-2+3", "-1e3", "@SUM(A1)", "\tx", "\r=x"]) assert.equal(escapeFormulaTrigger(dangerous), `'${dangerous}`);
  for (const plainNumber of ["-5", "+1", "-0.25", "12"]) assert.equal(escapeFormulaTrigger(plainNumber), plainNumber);
  assert.equal(escapeFormulaTrigger("safe"), "safe");
  assert.equal(escapeFormulaTrigger(-5), -5);
  assert.deepEqual(["12", "-3.5", "007", "1e5", "12 ", "x"].map(typeNumericText), [12, -3.5, "007", "1e5", 12, "x"]);
  assert.deepEqual(normalizeRowsForWriting([{ a: 1, b: { x: 1 } }, { c: true }]), { header: ["a", "b", "c"], body: [[1, '{"x":1}', null], [null, null, true]] });
  assert.deepEqual(normalizeRowsForWriting([[1, "x"]]), { header: null, body: [[1, "x"]] });
  assert.throws(() => normalizeRowsForWriting([[1], { a: 1 }]), { kind: "invalid_input" });
  assert.equal(detectDelimiter('a;b;"c,d"\n1;2;3'), ";");
  assert.equal(detectDelimiter("a\tb\n"), "\t");
});

test("zip bombs: declared unpacked size and entry count are checked before unpacking", () => {
  const bomb = buildZip([{ name: "xl/a.xml", content: Buffer.alloc(5_000_000) }]);
  assert.ok(bomb.length < 20000);
  assert.throws(() => assertZipWithinLimits(bomb, { maxUnzippedBytes: 1_000_000, maxEntries: 10 }), { kind: "invalid_input" });
  assert.doesNotThrow(() => assertZipWithinLimits(bomb, { maxUnzippedBytes: 10_000_000, maxEntries: 10 }));
  assert.throws(() => assertZipWithinLimits(buildZip([{ name: "a", content: Buffer.from("x") }, { name: "b", content: Buffer.from("y") }]), { maxUnzippedBytes: 1e9, maxEntries: 1 }), { kind: "invalid_input" });
  assert.throws(() => assertZipWithinLimits(Buffer.from("not a zip at all, definitely not"), { maxUnzippedBytes: 1e9, maxEntries: 10 }), { kind: "invalid_input" });
});

test("read CSV: delimiter detection, header row, row cap; files outside the allowlist are not_found", options, () =>
  withTableRunner({}, async ({ runOperation, inputDirectory, outsideDirectory }) => {
    await writeFile(join(inputDirectory, "orders.csv"), "﻿id;item;note\n1;kopi;\"a;b\"\n2;teh;\n3;susu;x\n");
    await writeFile(join(outsideDirectory, "secret.csv"), "a\n1\n");
    const { data } = await runOperation("read", { input: "orders.csv", max_rows: 2 }, AS_TOOL);
    assert.deepEqual(data.columns, ["id", "item", "note"]);
    assert.deepEqual(data.rows, [{ id: "1", item: "kopi", note: "a;b" }, { id: "2", item: "teh", note: "" }]);
    assert.deepEqual([data.delimiter, data.truncated, data.format], [";", true, "csv"]);
    const arrays = await runOperation("read", { input: "orders.csv", header_row: 0, row_format: "arrays", max_rows: 1 }, AS_TOOL);
    assert.deepEqual(arrays.data.rows, [["id", "item", "note"]]);
    await assert.rejects(runOperation("read", { input: join(outsideDirectory, "secret.csv") }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("read", { input: "orders.csv", sheet: "x" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("XLSX: list sheets, read formulas as values, dates, rich text, sheet by index, ranges", options, () =>
  withTableRunner({}, async ({ runOperation, inputDirectory }) => {
    await writeTestWorkbook(join(inputDirectory, "shop.xlsx"));
    const sheets = await runOperation("list_sheets", { input: "shop.xlsx" }, AS_TOOL);
    assert.deepEqual(sheets.data.sheets.map((sheet) => [sheet.name, sheet.index, sheet.state]), [["Products", 1, "visible"], ["Notes", 2, "hidden"]]);
    const { data } = await runOperation("read", { input: "shop.xlsx" }, AS_TOOL);
    assert.deepEqual(data.rows[0], { name: "kopi", price: 15000, qty: 2, total: 30000, added: "2026-01-02T00:00:00.000Z" });
    assert.equal(data.rows[1].name, "teh manis");
    const ranged = await runOperation("read", { input: "shop.xlsx", range: "B1:C3" }, AS_TOOL);
    assert.deepEqual(ranged.data.rows, [{ price: 15000, qty: 2 }, { price: 8000, qty: 3 }]);
    const notes = await runOperation("read", { input: "shop.xlsx", sheet: "2", header_row: 0 }, AS_TOOL);
    assert.deepEqual(notes.data.rows, [{ column_1: "hello" }]);
    await assert.rejects(runOperation("read", { input: "shop.xlsx", sheet: "Missing" }, AS_TOOL), { kind: "invalid_input" });
    await writeFile(join(inputDirectory, "fake.xlsx"), "plain text");
    await assert.rejects(runOperation("read", { input: "fake.xlsx" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("write CSV escapes formula triggers; only nodes may turn that off; XLSX cells stay literal", options, () =>
  withTableRunner({}, async ({ runOperation }) => {
    const rows = [{ name: "=HYPERLINK(\"http://evil\",\"x\")", amount: -5, note: "-minus" }];
    const csv = await runOperation("write", { rows, output_name: "report" }, AS_TOOL);
    assert.match(csv.data.file_name, /^report-.*\.csv$/);
    assert.equal(await readFile(csv.data.path, "utf8"), "name,amount,note\n\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\",-5,'-minus\n");
    await assert.rejects(runOperation("write", { rows, csv_injection_protection: false }, AS_TOOL), { kind: "permission_denied" });
    const raw = await runOperation("write", { rows, csv_injection_protection: false }, AS_NODE);
    assert.ok((await readFile(raw.data.path, "utf8")).includes("\n\"=HYPERLINK"));
    const xlsx = await runOperation("write", { rows, format: "xlsx", sheet_name: "Data" }, AS_TOOL);
    const workbook = new Excel.Workbook();
    await workbook.xlsx.load(await readFile(xlsx.data.path));
    const cell = workbook.getWorksheet("Data").getCell("A2");
    assert.equal(cell.value, "=HYPERLINK(\"http://evil\",\"x\")");
    assert.equal(cell.formula, undefined);
    await assert.rejects(runOperation("write", { rows, format: "xlsx", sheet_name: "a/b" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("convert CSV to XLSX (numbers typed, leading zeros kept) and XLSX to CSV (protected)", options, () =>
  withTableRunner({}, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeFile(join(inputDirectory, "codes.csv"), "code,count\n007,12\n=cmd,3.5\n");
    const toXlsx = await runOperation("convert", { input: "codes.csv", to: "xlsx" }, AS_TOOL);
    const workbook = new Excel.Workbook();
    await workbook.xlsx.load(await readFile(toXlsx.data.path));
    assert.deepEqual(workbook.worksheets[0].getRow(2).values.slice(1), ["007", 12]);
    const back = await runOperation("convert", { input: toXlsx.data.path, to: "csv" }, AS_TOOL);
    assert.equal(await readFile(back.data.path, "utf8"), "code,count\n007,12\n'=cmd,3.5\n");
    assert.equal((await readdir(outputDirectory)).length, 2);
  }));

test("row cap from EXCEL_CSV_MAX_ROWS applies to reads, writes and conversions", options, () =>
  withTableRunner({ environment: { EXCEL_CSV_MAX_ROWS: "2" } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "big.csv"), "a\n1\n2\n3\n4\n");
    assert.equal((await runOperation("read", { input: "big.csv", max_rows: 100 }, AS_TOOL)).data.row_count, 2);
    await assert.rejects(runOperation("write", { rows: [[1], [2], [3]] }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("convert", { input: "big.csv", to: "xlsx" }, AS_TOOL), { kind: "invalid_input" });
  }));

// Builds a minimal deflate zip so the bomb check can be tested without a zip library.
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const compressed = deflateRawSync(content);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, nameBytes, compressed);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}
