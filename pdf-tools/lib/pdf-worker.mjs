/**
 * Child process entry: runs one PDF engine task received over IPC and sends
 * back `{ok, result}` or `{ok: false, error: {kind, message}}`. Its stdout is
 * ignored by the parent (pdfjs warnings print there), and it exits after
 * replying.
 */
import { runEngineTask } from "./pdf-engine.mjs";
import { classifyImportError } from "./errors.mjs";

process.once("message", async ({ task, payload }) => {
  try {
    const result = await runEngineTask(task, payload);
    process.send({ ok: true, result }, () => process.exit(0));
  } catch (taskError) {
    const classified = classifyPdfImportError(taskError);
    process.send({ ok: false, error: { kind: classified.kind ?? "plugin_error", message: classified.message ?? String(classified) } }, () => process.exit(0));
  }
});

function classifyPdfImportError(taskError) {
  const missingPackage = /pdfjs-dist/.test(taskError?.message ?? "") ? "pdfjs-dist" : "pdf-lib";
  return classifyImportError(missingPackage, "pdf-tools", taskError);
}
