// Worker process for one sqlite call: receives a request over IPC, runs it, replies and exits.
// Started by worker-launcher.mjs with stdout ignored, because the plugin's stdout carries the protocol.
import { runSqliteRequest } from "./sqlite-statement-runner.mjs";

process.once("message", async (request) => {
  let response;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    response = { ok: true, results: runSqliteRequest(request, DatabaseSync) };
  } catch (runError) {
    response = { ok: false, error: serializeError(runError) };
  }
  process.send(response, () => process.exit(0));
});

function serializeError(runError) {
  return {
    message: String(runError?.message ?? runError),
    code: runError?.code ?? null,
    errcode: runError?.errcode ?? null,
    errstr: runError?.errstr ?? null,
    kind: runError?.name === "PluginError" ? runError.kind : null,
  };
}
