/**
 * Child process entry: runs one document engine task received over IPC and
 * sends back `{ok, result}` or `{ok: false, error: {kind, message}}`. Its
 * stdout is ignored by the parent, and it exits after replying.
 */
import { runEngineTask } from "./document-engine.mjs";
import { classifyImportError } from "./errors.mjs";

const PACKAGE_NAMES = ["pdfmake", "pdf-lib", "@pdf-lib/fontkit", "fontkit", "docxtemplater", "pizzip", "@neslinesli93/qpdf-wasm"];

// pdf-lib reports what it skips in a damaged or protected PDF with console.warn, one line per object: thousands
// of lines in the log of whoever runs the plugin, for a file that is then refused with one clear message.
console.warn = () => {};

process.once("message", async ({ task, payload }) => {
  try {
    const result = await runEngineTask(task, payload);
    process.send({ ok: true, result }, () => process.exit(0));
  } catch (taskError) {
    const missingPackage = PACKAGE_NAMES.find((packageName) => String(taskError?.message ?? "").includes(`'${packageName}'`)) ?? "pdfmake";
    const classified = classifyImportError(missingPackage, "document-templates", taskError);
    process.send({ ok: false, error: { kind: classified.kind ?? "plugin_error", message: classified.message ?? String(classified) } }, () => process.exit(0));
  }
});
