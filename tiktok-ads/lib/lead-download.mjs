/**
 * `download_leads`, written by hand: the file endpoint answers a finished task with the CSV/zip bytes, but answers
 * errors (task not ready, bad token, no permission) with HTTP 200 and a JSON `{code, message}` body. The layer's
 * binary responses save whatever comes back, so this operation reads JSON answers instead, maps their `code` with
 * the plugin's error spec, and only saves non-JSON bodies into $TIKTOK_ADS_LEADS_DIR.
 */
import { isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { classifyTransferError, saveResponseToFile } from "./shared/public-https-fetch.mjs";
import { createBodyErrorDetector } from "./shared/rest-errors.mjs";

const MAX_LEAD_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Creates the operation.
 *
 * @param options - `{errors, leadsOptInEnv, directoryEnv}`: the plugin's `errors` spec and env names (object)
 * @returns Operation `{name, title, description, parameters, run}` (object)
 */
export function createDownloadLeadsOperation({ errors, leadsOptInEnv, directoryEnv }) {
  const detectBodyError = createBodyErrorDetector(errors);
  return {
    name: "download_leads",
    title: "Download leads",
    description: `Save the CSV or zip file of a finished lead download task into ${directoryEnv} (the file expires 10 minutes after it is ready) (as an agent tool only when ${leadsOptInEnv}=1)`,
    parameters: {
      type: "object",
      properties: {
        advertiser_id: { type: "string", minLength: 1, description: "Advertiser (ad account) id" },
        task_id: { type: "string", minLength: 1, description: "task_id from create_lead_download_task" },
        lead_region: { type: "string", enum: ["eu", "us"], description: "eu: EEA, Switzerland and UK leads; us: US leads; omit for all other regions" },
      },
      required: ["advertiser_id", "task_id"],
    },
    run: async ({ client, args, environment, signal, source }) => {
      if (source === "tool" && environment?.[leadsOptInEnv] !== "1") {
        throw new PluginError(`\`download_leads\` is disabled for agent tools; set ${leadsOptInEnv}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
      }
      const directory = await prepareDirectory(environment, directoryEnv);
      const headers = args.lead_region ? { "x-lead-region": args.lead_region } : {};
      const query = { advertiser_id: args.advertiser_id, task_id: args.task_id };
      const rawResult = await client.requestWithHeaders({ method: "GET", path: "/page/lead/task/download/", query, headers, signal, redactResponse: true, rawResponse: true });
      if (await looksLikeJsonAnswer(rawResult.response)) throw await describeJsonAnswer(rawResult, detectBodyError);
      return { data: await saveLeadFile(rawResult.response, directory, signal), next_cursor: null };
    },
  };
}

async function prepareDirectory(environment, directoryEnv) {
  const directory = environment?.[directoryEnv]?.trim();
  if (!directory || !isAbsolute(directory)) throw new PluginError(`download_leads saves a file: set ${directoryEnv} to an absolute directory path`, { kind: "invalid_input" });
  await mkdir(directory, { recursive: true });
  return directory;
}

const JSON_ANSWER_START = /^\s*\{\s*"(code|message|request_id)"\s*:/;

// TikTok's errors are JSON, but not always labelled as JSON: peek at the start of a copy of the body too,
// so an error is never saved as the lead file and reported as success.
async function looksLikeJsonAnswer(response) {
  if (/json/i.test(response.headers.get("content-type") ?? "")) return true;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  try {
    const { value } = await reader.read();
    return JSON_ANSWER_START.test(new TextDecoder().decode(value ?? new Uint8Array()).slice(0, 64));
  } finally {
    // Not awaited: cancelling one branch of a cloned (tee'd) body only settles once the other branch ends too.
    reader.cancel().catch(() => {});
  }
}

async function describeJsonAnswer(rawResult, detectBodyError) {
  const text = rawResult.redact(await rawResult.response.text());
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return new PluginError(`TikTok answered with unreadable JSON instead of the lead file: ${text.slice(0, 300)}`, { kind: "api_error" });
  }
  const bodyError = detectBodyError(body);
  if (bodyError) return new PluginError(`API error: ${bodyError.message}`, { kind: bodyError.kind, retryable: bodyError.kind === "rate_limited" });
  return new PluginError(`TikTok answered with JSON instead of the lead file (nothing was saved): ${text.slice(0, 300)}`, { kind: "api_error" });
}

async function saveLeadFile(response, directory, signal) {
  const fileBaseName = `tiktok-leads-${Date.now()}-${randomBytes(3).toString("hex")}`;
  try {
    return await saveResponseToFile(response, { directory, fileBaseName, maxBytes: MAX_LEAD_FILE_BYTES, label: "download_leads" });
  } catch (saveError) {
    throw classifyTransferError(saveError, signal);
  }
}
