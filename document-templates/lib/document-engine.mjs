/**
 * The tasks that run inside the worker process: everything that parses a
 * file someone supplied (PDF, .docx, images, fonts) or lays out pages.
 */
import { operationFailed } from "./errors.mjs";
import { fillDocx, inspectDocx } from "./docx-filler.mjs";
import { fillPdfForm, inspectPdfForm } from "./pdf-form.mjs";
import { renderLayoutPdf } from "./pdf-renderer.mjs";

const TASKS = {
  render_layout: renderLayoutPdf,
  inspect_pdf_form: inspectPdfForm,
  fill_pdf_form: fillPdfForm,
  inspect_docx: inspectDocx,
  fill_docx: fillDocx,
};

/**
 * Runs one engine task.
 *
 * @param task - Task name (string)
 * @param payload - Task input (object)
 * @returns `{data, outputs?}` (object)
 * @throws PluginError kind `plugin_error` - When the task is unknown
 */
export async function runEngineTask(task, payload) {
  if (!Object.hasOwn(TASKS, task)) throw operationFailed(`Unknown document task ${JSON.stringify(task)}`);
  return TASKS[task](payload);
}
