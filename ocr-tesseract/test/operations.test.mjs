import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { describeFailure } from "../lib/client.mjs";
import { validateLanguages } from "../operations/ocr-operations.mjs";
import { AS_TOOL, PNG_HEADER, SKIP_WITHOUT_MAGICK, SKIP_WITHOUT_TESSERACT, createFakeProcessRunner, withOcrRunner } from "./helpers.mjs";

test("manifest: local only, no secrets, two tools, program env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["list_languages", "ocr"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  for (const variableName of ["OCR_TESSERACT_INPUT_DIRS", "OCR_TESSERACT_OUTPUT_DIR", "OCR_TESSERACT_TIMEOUT_MS", "TESSERACT_BINARY", "PDFTOPPM_BINARY"]) assert.ok(manifest.permissions.env.includes(variableName));
});

test("languages must be well-formed and installed", () => {
  assert.deepEqual(validateLanguages(["eng", "ind"], ["eng", "ind", "osd"]), ["eng", "ind"]);
  for (const languages of [[], ["fra"], ["eng+fra"], ["../eng"], ["-c"], ["a", "b", "c", "d", "e", "f"]]) {
    assert.throws(() => validateLanguages(languages, ["eng"]), { kind: "invalid_input" }, languages.join(","));
  }
});

test("failure mapping: broken installs are setup_required, unreadable inputs invalid_input", () => {
  const longDyldError = `dyld[1]: Library not loaded: libgpgmepp.6.dylib\n  Reason: ${"tried: '/x/libgpgmepp.6.dylib' (no such file), ".repeat(20)}`;
  assert.equal(describeFailure("pdftoppm", { exitCode: null, signalCode: "SIGABRT", stderr: longDyldError }, "hint").kind, "setup_required");
  assert.equal(describeFailure("tesseract", { exitCode: 1, stderr: "Failed loading language 'xyz'" }, "hint").kind, "setup_required");
  assert.equal(describeFailure("pdftoppm", { exitCode: 99, stderr: "Wrong page range given" }, "hint").kind, "invalid_input");
  assert.equal(describeFailure("tesseract", { exitCode: 1, stderr: "segfault" }, "hint").kind, "plugin_error");
});

test("ocr passes an argument array with the real path, languages and psm; no shell", () => {
  const fake = createFakeProcessRunner({ ocrText: "Halo Dunia" });
  return withOcrRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "scan.png"), PNG_HEADER);
    const { data } = await runOperation("ocr", { input: "scan.png", languages: "[\"eng\", \"ind\"]", psm: "6", output_format: "tsv" }, AS_TOOL);
    assert.deepEqual([data.text, data.input_kind, data.format, data.truncated], ["Halo Dunia", "image", "tsv", false]);
    assert.deepEqual(fake.requests[1].args, [join(inputDirectory, "scan.png"), "stdout", "-l", "eng+ind", "--psm", "6", "tsv"]);
    assert.equal(fake.requests[1].command, "tesseract");
  });
});

test("text files (tesseract image lists), SVGs and outside files are refused before tesseract runs on them", () => {
  const fake = createFakeProcessRunner();
  return withOcrRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory, outsideDirectory }) => {
    await writeFile(join(outsideDirectory, "secret.png"), PNG_HEADER);
    await writeFile(join(inputDirectory, "list.png"), `${join(outsideDirectory, "secret.png")}\n`);
    await writeFile(join(inputDirectory, "vector.png"), "<svg/>");
    await assert.rejects(runOperation("ocr", { input: "list.png" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("ocr", { input: "vector.png" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("ocr", { input: join(outsideDirectory, "secret.png") }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("ocr", { input: "list.png", languages: ["fra"] }, AS_TOOL), { kind: "invalid_input" });
    assert.ok(fake.requests.every((request) => request.args[0] === "--list-langs"));
  });
});

test("PDF pages are rendered with pdftoppm into a temp directory, then OCRed at the same dpi", () => {
  const fake = createFakeProcessRunner({ ocrText: "Page two" });
  return withOcrRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "doc.pdf"), "%PDF-1.4\n");
    const { data } = await runOperation("ocr", { input: "doc.pdf", page: 2, dpi: 200 }, AS_TOOL);
    assert.deepEqual([data.text, data.input_kind, data.page], ["Page two", "pdf", 2]);
    const [, render, recognize] = fake.requests;
    const side = String(Math.floor(Math.sqrt(40_000_000)));
    assert.deepEqual(render.args.slice(0, 16), ["-f", "2", "-l", "2", "-r", "200", "-x", "0", "-y", "0", "-W", side, "-H", side, "-png", "-singlefile"]);
    assert.equal(render.args[16], join(inputDirectory, "doc.pdf"));
    assert.deepEqual(recognize.args.slice(1), ["stdout", "-l", "eng", "--psm", "3", "--dpi", "200"]);
  });
});

test("save_output writes the result to a new file; max_chars cuts the returned text", () => {
  const fake = createFakeProcessRunner({ ocrText: "x".repeat(500) });
  return withOcrRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "scan.png"), PNG_HEADER);
    const { data } = await runOperation("ocr", { input: "scan.png", max_chars: 100, save_output: true, output_format: "hocr" }, AS_TOOL);
    assert.equal(data.text.length, 100);
    assert.equal(data.truncated, true);
    assert.match(data.saved.file_name, /^scan-.*\.hocr$/);
    assert.equal((await readFile(data.saved.path, "utf8")).length, 500);
  });
});

test("a missing tesseract is setup_required", () =>
  withOcrRunner({ environment: { TESSERACT_BINARY: "/nonexistent/tesseract" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("list_languages", {}, AS_TOOL), { kind: "setup_required" });
  }));

test("real tesseract reads a generated image", { skip: SKIP_WITHOUT_TESSERACT || SKIP_WITHOUT_MAGICK, timeout: 60000 }, () =>
  withOcrRunner({}, async ({ runOperation, inputDirectory }) => {
    const imagePath = join(inputDirectory, "hello.png");
    spawnSync("magick", ["-size", "600x120", "xc:white", "-fill", "black", "-pointsize", "48", "-annotate", "+20+80", "Halo Dunia 2026", imagePath]);
    const languages = await runOperation("list_languages", {}, AS_TOOL);
    assert.ok(languages.data.languages.includes("eng"));
    const { data } = await runOperation("ocr", { input: "hello.png", psm: 7 }, AS_TOOL);
    assert.equal(data.text.trim(), "Halo Dunia 2026");
    const tsv = await runOperation("ocr", { input: "hello.png", psm: 7, output_format: "tsv" }, AS_TOOL);
    assert.ok(tsv.data.text.startsWith("level\tpage_num"));
  }));
