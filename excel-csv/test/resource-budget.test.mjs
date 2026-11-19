/**
 * Review regressions: files built to make parsing allocate gigabytes (the reviewer's review6/mkxl.mjs,
 * a 900k-column CSV, review6/mkzipbomb.mjs) must end in a bounded result or a clean error, never an
 * out-of-memory crash of the plugin process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fitRowsToBudget } from "../lib/table-values.mjs";
import { AS_TOOL, Excel, SKIP_WITHOUT_LIBRARIES, withTableRunner } from "./helpers.mjs";

const options = { skip: SKIP_WITHOUT_LIBRARIES, timeout: 120000 };

// review6/mkxl.mjs: three cells, one of them at XFD1, so the used range is 16384 columns by 5000 rows.
async function buildWideWorkbook() {
  const workbook = new Excel.Workbook();
  const worksheet = workbook.addWorksheet("S");
  worksheet.getCell("A1").value = "a";
  worksheet.getCell("XFD1").value = "z";
  worksheet.getCell("A5000").value = "end";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// review6/mkzipbomb.mjs: the sheet XML padded with spaces, and every declared uncompressed size patched to 100 bytes.
async function buildLyingZipBomb(paddingMegabytes) {
  const JSZip = createRequire(import.meta.url)("jszip");
  const source = await JSZip.loadAsync(await buildWideWorkbook());
  const output = new JSZip();
  for (const [name, entry] of Object.entries(source.files)) {
    if (entry.dir) continue;
    let content = await entry.async("nodebuffer");
    if (name === "xl/worksheets/sheet1.xml") content = Buffer.from(content.toString("utf8").replace("<sheetData>", `<sheetData>${" ".repeat(paddingMegabytes * 1024 * 1024)}`));
    output.file(name, content, { compression: "DEFLATE", compressionOptions: { level: 9 } });
  }
  const bytes = await output.generateAsync({ type: "nodebuffer" });
  const endOffset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = bytes.readUInt32LE(endOffset + 16);
  for (let index = 0; index < bytes.readUInt16LE(endOffset + 10); index += 1) {
    bytes.writeUInt32LE(100, offset + 24);
    bytes.writeUInt32LE(100, bytes.readUInt32LE(offset + 42) + 22);
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return bytes;
}

test("fitRowsToBudget charges width x rows before padding, and caps columns and bytes", () => {
  const wideFirstRow = [Array.from({ length: 900000 }, () => ""), ["a"], ["b"]];
  const fitted = fitRowsToBudget(wideFirstRow, { maxColumns: 100, maxCells: 250, maxBytes: 1e9 });
  assert.equal(fitted.rows.length, 2);
  assert.equal(fitted.rows[0].length, 100);
  assert.equal(fitted.truncated, true);
  assert.deepEqual(fitRowsToBudget([["x".repeat(10)], ["y".repeat(10)]], { maxColumns: 10, maxCells: 100, maxBytes: 20 }), { rows: [["x".repeat(10)]], truncated: true });
  assert.deepEqual(fitRowsToBudget([["a"], ["b", "c"]], { maxColumns: 10, maxCells: 100, maxBytes: 1e9 }), { rows: [["a", null], ["b", "c"]], truncated: false });
});

test("review regression: a 6 KB XLSX with a cell at XFD1 reads only existing cells, within the column cap", options, () =>
  withTableRunner({}, async ({ runOperation, inputDirectory }) => {
    const workbookBytes = await buildWideWorkbook();
    assert.ok(workbookBytes.length < 10000);
    await writeFile(join(inputDirectory, "wide.xlsx"), workbookBytes);
    const { data } = await runOperation("read", { input: "wide.xlsx", header_row: 0, max_rows: 10000, row_format: "arrays" }, AS_TOOL);
    assert.equal(data.columns.length, 1);
    assert.equal(data.row_count, 5000);
    assert.deepEqual([data.rows[0], data.rows[4999], data.truncated], [["a"], ["end"], true]);
    await assert.rejects(runOperation("convert", { input: "wide.xlsx", to: "csv" }, AS_TOOL), { kind: "invalid_input" });
  }));

test("review regression: with all 16384 columns allowed the wide XLSX stops at the cell budget", options, () =>
  withTableRunner({ environment: { EXCEL_CSV_MAX_COLUMNS: "16384", EXCEL_CSV_MAX_CELLS: "100000" } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "wide.xlsx"), await buildWideWorkbook());
    const { data } = await runOperation("read", { input: "wide.xlsx", header_row: 0, max_rows: 10000, row_format: "arrays" }, AS_TOOL);
    assert.equal(data.columns.length, 16384);
    assert.ok(data.row_count * 16384 <= 100000);
    assert.equal(data.truncated, true);
  }));

test("review regression: a CSV whose first line has 900k commas is cut to the column cap before padding", options, () =>
  withTableRunner({}, async ({ runOperation, inputDirectory }) => {
    const csvText = `${",".repeat(900000)}\n${"1,2\n".repeat(2000)}`;
    await writeFile(join(inputDirectory, "wide.csv"), csvText);
    const { data } = await runOperation("read", { input: "wide.csv", header_row: 0, max_rows: 5000, row_format: "arrays" }, AS_TOOL);
    assert.equal(data.columns.length, 1000);
    assert.equal(data.truncated, true);
    assert.ok(data.row_count <= 500);
  }));

// The declared sizes pass the zip-directory check; the unzip then fails on the size mismatch (or, were it to keep
// inflating, the 128 MB worker budget would stop it). Either way the plugin process is untouched.
test("review regression: a zip bomb that lies about its sizes fails cleanly inside the worker's 128 MB budget", options, () =>
  withTableRunner({ environment: { EXCEL_CSV_MAX_MEMORY_MB: "128" } }, async ({ runOperation, inputDirectory }) => {
    const bombBytes = await buildLyingZipBomb(400);
    assert.ok(bombBytes.length < 2 * 1024 * 1024);
    await writeFile(join(inputDirectory, "bomb.xlsx"), bombBytes);
    const pattern = /size mismatch|EXCEL_CSV_MAX_MEMORY_MB/;
    await assert.rejects(runOperation("read", { input: "bomb.xlsx" }, AS_TOOL), (error) => ["invalid_input", "plugin_error"].includes(error.kind) && pattern.test(error.message));
    await assert.rejects(runOperation("list_sheets", { input: "bomb.xlsx" }, AS_TOOL), (error) => pattern.test(error.message));
    assert.equal((await runOperation("write", { rows: [["still alive"]] }, AS_TOOL)).data.row_count, 1);
  }));

test("review regression: the table worker is killed when its resident memory passes the budget", options, () =>
  withTableRunner({ environment: { EXCEL_CSV_MAX_MEMORY_MB: "128", EXCEL_CSV_MAX_CELLS: "50000000", EXCEL_CSV_MAX_COLUMNS: "16384", EXCEL_CSV_MAX_RESULT_BYTES: "1073741824" } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "wide.csv"), `${"x,".repeat(16383)}x\n`.repeat(600));
    await assert.rejects(runOperation("read", { input: "wide.csv", max_rows: 1000 }, AS_TOOL), (error) => /EXCEL_CSV_MAX_MEMORY_MB/.test(error.message));
  }));
