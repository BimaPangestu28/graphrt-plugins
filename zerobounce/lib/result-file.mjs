/**
 * ZeroBounce's getfile answers a failure (unknown file id, file not finished) with a 200 JSON body such as
 * {"success": false, "message": "File cannot be found."}. In binary mode the layer would save that body as the
 * "result file", so this wrapper reads back small JSON files, deletes them and raises the API's message instead.
 * Result files are renamed to .csv (ZeroBounce serves them as application/octet-stream).
 */
import { readFile, rename, unlink } from "node:fs/promises";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readErrorBody(savedFile) {
  if (!/json/i.test(String(savedFile?.content_type ?? "")) || savedFile.bytes > MAX_ERROR_BODY_BYTES) return null;
  try {
    const body = JSON.parse(await readFile(savedFile.path, "utf8"));
    return body && typeof body === "object" && (body.success === false || typeof body.error === "string") ? body : null;
  } catch {
    // Not JSON after all: it is a result file, keep it.
    return null;
  }
}

// getfile serves CSV as application/octet-stream, which the layer saves as ".bin"; results are always CSV.
async function renameToCsv(savedFile) {
  if (!savedFile?.path || savedFile.path.endsWith(".csv")) return savedFile;
  const csvPath = savedFile.path.replace(/\.[A-Za-z0-9]{1,5}$/, "") + ".csv";
  await rename(savedFile.path, csvPath);
  return { ...savedFile, path: csvPath };
}

/**
 * Wraps the get_file operation: a saved JSON error body becomes an error and the file is removed; a result file
 * gets the .csv extension.
 *
 * @param operation - get_file operation (object)
 * @returns Operation with the check (object)
 */
export function rejectJsonErrorFile(operation) {
  return {
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      const errorBody = await readErrorBody(result?.data);
      if (!errorBody) return { ...result, data: await renameToCsv(result?.data) };
      await unlink(result.data.path);
      const message = [errorBody.message, errorBody.error].find((candidate) => typeof candidate === "string" && candidate !== "") ?? "getfile returned an error";
      throw new PluginError(`API error: ${message}`, { kind: "api_error" });
    },
  };
}
