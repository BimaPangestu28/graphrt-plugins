/**
 * Child process entry for table parsing: runs one read task received over IPC
 * and replies `{ok, result}` or `{ok: false, error: {kind, message}}`, then
 * exits. Parsing lives here so a hostile file can only exhaust a process the
 * plugin kills (see isolated-task.mjs), never the plugin itself.
 */
import { listWorkbookSheets, readCsvRows, readXlsxRows } from "./table-io.mjs";
import { operationFailed } from "./errors.mjs";

const TABLE_TASKS = {
  read_csv: ({ bytes, options }) => readCsvRows(Buffer.from(bytes), options),
  read_xlsx: ({ bytes, options }) => readXlsxRows(Buffer.from(bytes), options),
  list_sheets: ({ bytes }) => listWorkbookSheets(Buffer.from(bytes)),
};

process.once("message", async ({ task, payload }) => {
  try {
    const runTask = TABLE_TASKS[task];
    if (!runTask) throw operationFailed(`Unknown table task ${task}`);
    const result = await runTask(payload);
    process.send({ ok: true, result }, () => process.exit(0));
  } catch (taskError) {
    process.send({ ok: false, error: { kind: taskError.kind ?? "plugin_error", message: taskError.message ?? String(taskError) } }, () => process.exit(0));
  }
});
