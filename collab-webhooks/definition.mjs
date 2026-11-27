/**
 * collab-webhooks plugin definition: posts the events of a Graphrt collaboration workspace (a project changed, a
 * version was saved, someone joined) to a webhook, signed with HMAC-SHA256.
 *
 * It is a plugin service (`services` in the manifest): a collaboration server (`graphrt collab`) calls the
 * `deliver` tool for each event of a workspace whose owner enabled the service, with the workspace secrets the
 * owner granted (`WEBHOOK_URL`, `WEBHOOK_SECRET`) in the tool call's context. In a workflow it is a plain node
 * that posts to `COLLAB_WEBHOOK_URL`.
 *
 * Slack and Microsoft Teams incoming webhooks read the `text` field; any other endpoint gets the whole event and
 * checks `X-Graphrt-Signature` (`sha256=<hex HMAC of the body>`).
 */
import { createHmac } from "node:crypto";
import { PluginError } from "./lib/shared/graphrt-plugin.mjs";
import { postPublicHttps, resolveWithDns } from "./lib/shared/public-https-fetch.mjs";

const URL_VARIABLE = "COLLAB_WEBHOOK_URL";
const SECRET_VARIABLE = "COLLAB_WEBHOOK_SECRET";
const DELIVERY_TIMEOUT_MS = 15000;
const MAX_TEXT_CHARS = 300;

const EVENT_TEXT = {
  "project.changed": (event) => `${who(event)} changed ${quoted(event.project?.name ?? "a project")} in ${quoted(event.workspace?.name)}`,
  "version.saved": (event) => {
    const label = event.details?.label ? ` ${quoted(event.details.label)}` : "";
    return `${who(event)} saved version ${event.details?.version ?? ""}${label} of ${quoted(event.project?.name ?? "a project")} in ${quoted(event.workspace?.name)}`;
  },
  "member.joined": (event) => `${event.details?.account?.name ?? "Someone"} joined ${quoted(event.workspace?.name)} (${event.details?.role ?? "member"})`,
};

function who(event) {
  return event.details?.by_name ?? event.details?.by ?? "Someone";
}

function quoted(text) {
  return `“${String(text ?? "").slice(0, 120)}”`;
}

/**
 * The one line summary of an event, as chat webhooks show it.
 *
 * @param event - `{event, workspace, project, details}` (object)
 * @returns Text, at most 300 characters (string)
 */
export function describeEvent(event) {
  const describe = EVENT_TEXT[event.event];
  const text = describe ? describe(event) : `Test message from Graphrt for ${quoted(event.workspace?.name)}`;
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text;
}

/**
 * `sha256=<hex>` of the body with the secret, the value of `X-Graphrt-Signature`.
 *
 * @param secret - Shared secret (string)
 * @param body - Exact request body (string)
 * @returns Signature header value (string)
 */
export function signBody(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const objectParameter = (description) => ({ type: "object", description });

const deliver = {
  name: "deliver",
  title: "Send a workspace event to a webhook",
  description:
    "Post one collaboration workspace event (project.changed, version.saved, member.joined) to the webhook, signed with HMAC-SHA256. Without an event it sends a test message.",
  parameters: {
    type: "object",
    properties: {
      event: { type: "string", enum: ["project.changed", "version.saved", "member.joined"], description: "The event (none: a test message)" },
      workspace: objectParameter("The workspace: {id, name}"),
      project: objectParameter("The project: {id, name}"),
      details: objectParameter("What happened (who, version, role)"),
      at_ms: { type: "integer", minimum: 0, description: "When it happened, Unix milliseconds" },
      call: objectParameter("Set when a member calls the service directly (a test)"),
      caller: objectParameter("Who called the service: {id, name, role}"),
    },
    required: [],
  },
  run: async ({ client, args, toolContext, signal }) => {
    const secrets = toolContext?.secrets ?? {};
    const webhookUrl = secrets.WEBHOOK_URL || client.defaultUrl;
    if (!webhookUrl) {
      throw new PluginError(`No webhook address: grant the WEBHOOK_URL secret to the service, or set ${URL_VARIABLE}`, { kind: "auth_error" });
    }
    const signingSecret = secrets.WEBHOOK_SECRET || client.defaultSecret;
    const event = {
      type: args.event ?? "test",
      event: args.event ?? "test",
      workspace: pick(args.workspace, ["id", "name"]),
      project: pick(args.project, ["id", "name"]),
      details: args.details ?? {},
      caller: args.caller ? pick(args.caller, ["id", "name", "role"]) : undefined,
      at_ms: args.at_ms ?? Date.now(),
    };
    const payload = { text: describeEvent({ ...args, details: { ...args.details, by_name: args.caller?.name } }), graphrt: event };
    const body = JSON.stringify(payload);
    const headers = { "content-type": "application/json", "user-agent": "graphrt-collab-webhooks/0.1" };
    if (signingSecret) headers["x-graphrt-signature"] = signBody(signingSecret, body);
    const timeout = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
    const response = await postPublicHttps(webhookUrl, {
      body,
      headers,
      fetchImpl: client.fetchImpl,
      resolveHostAddresses: client.resolveHostAddresses,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      label: "webhook",
    }).catch((caught) => {
      // The address is a secret of the workspace: never repeat it.
      if (caught instanceof PluginError) throw new PluginError(caught.message.replaceAll(webhookUrl, "(the webhook address)"), { kind: caught.kind ?? "invalid_input" });
      throw new PluginError(`The webhook could not be reached: ${caught?.cause?.message ?? caught?.message ?? caught}`, { kind: "network_error", retryable: true });
    });
    await response.body?.cancel?.().catch(() => {});
    if (response.status < 200 || response.status >= 300) {
      throw new PluginError(`The webhook answered HTTP ${response.status}`, { kind: "api_error", retryable: response.status >= 500 });
    }
    return { data: { delivered: true, status: response.status, event: event.event, signed: Boolean(signingSecret) } };
  },
};

function pick(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export const pluginDefinition = {
  name: "collab-webhooks",
  version: "0.1.0",
  description: "Posts the events of a Graphrt collaboration workspace (a project changed, a version saved, someone joined) to a webhook such as Slack or Teams, signed with HMAC-SHA256",
  tokenEnv: URL_VARIABLE,
  extraEnv: [SECRET_VARIABLE],
  // The webhook address is optional here: a collaboration server sends it per workspace as a secret.
  resolveAccessToken: ({ environment, nodeToken }) => nodeToken || environment?.[URL_VARIABLE] || null,
  limits: { timeout_ms: 30000, max_concurrency: 4 },
  createClient: ({ accessToken, environment, fetchImpl, resolveHostAddresses }) => ({
    defaultUrl: accessToken || null,
    defaultSecret: environment?.[SECRET_VARIABLE] || null,
    fetchImpl: fetchImpl ?? globalThis.fetch,
    resolveHostAddresses: resolveHostAddresses ?? resolveWithDns,
  }),
  operations: [deliver],
  services: [
    {
      id: "webhook",
      title: "Send changes to a webhook",
      description: "Posts to the team's webhook when a project changes, a version is saved or someone joins the workspace. Grant WEBHOOK_URL, and WEBHOOK_SECRET to sign the posts.",
      tool: "deliver",
      access: "owner",
      events: ["project.changed", "version.saved", "member.joined"],
      secrets: ["WEBHOOK_URL", "WEBHOOK_SECRET"],
      reads_projects: false,
    },
  ],
};
