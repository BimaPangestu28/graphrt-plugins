/**
 * Agent-tool guards that Graph API ids make necessary. Every Graph object (campaign, Page, lead, user) is read with
 * `GET /{id}`, and any object's fields can be expanded with `fields=`, so a path allowlist alone cannot keep agents
 * away from Page access tokens or lead PII:
 *   - refuseTokenQueries: api_request tool calls whose path or query mentions a token or secret are refused
 *     (`/{page-id}?fields=access_token`, `fields=accounts{access_token}`).
 *   - refuseLeadDataWithoutOptIn: tool results that contain lead answers (`field_data`, e.g. `GET /{lead-id}` or
 *     `fields=leads{field_data}` on an ad) are refused unless the leads opt-in env is "1".
 * Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const SECRET_WORDS = /token|secret|password|app_?secret_?proof/i;
const LEAD_DATA_KEYS = new Set(["field_data", "custom_disclaimer_responses"]);

/**
 * Returns the definition with api_request refusing agent-tool calls that ask for tokens or secrets.
 *
 * @param pluginDefinition - Definition with an api_request operation (object)
 * @returns A new definition (object)
 *
 * @example
 * refuseTokenQueries(definition); // api_request {path: "/123", query: {fields: "access_token"}} is refused for tools
 */
export function refuseTokenQueries(pluginDefinition) {
  const guardOperation = (operation) => {
    if (operation.name !== "api_request") return operation;
    const run = (context) => {
      if (context.source === "tool" && mentionsSecret(context.args)) {
        throw new PluginError("api_request cannot ask for tokens or secrets as an agent tool (path or query mentions one); use a workflow node", { kind: "permission_denied" });
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(guardOperation) };
}

/**
 * Whether an api_request call's path or query names a token or secret, after percent-decoding.
 *
 * @param args - api_request arguments `{path, query}` (object)
 * @returns True when the call must be refused for tools (boolean)
 *
 * @example
 * mentionsSecret({ path: "/me", query: { fields: "accounts{access_token}" } }); // true
 */
export function mentionsSecret(args) {
  const requestText = `${args?.path ?? ""} ${JSON.stringify(args?.query ?? {})}`;
  return SECRET_WORDS.test(requestText) || SECRET_WORDS.test(decodeRepeatedly(requestText));
}

function decodeRepeatedly(text) {
  let decodedText = text;
  for (let round = 0; round < 4; round += 1) {
    try {
      const nextText = decodeURIComponent(decodedText);
      if (nextText === decodedText) break;
      decodedText = nextText;
    } catch {
      break;
    }
  }
  return decodedText;
}

/**
 * Returns the definition with tool results that hold lead answers refused unless `optInEnv` is "1".
 *
 * @param pluginDefinition - Definition (object)
 * @param optInEnv - e.g. "META_ADS_TOOL_ALLOW_LEADS" (string)
 * @returns A new definition (object)
 */
export function refuseLeadDataWithoutOptIn(pluginDefinition, optInEnv) {
  const wrapOperation = (operation) => ({
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      if (context.source !== "tool" || context.environment?.[optInEnv] === "1" || !containsLeadData(result?.data)) return result;
      throw new PluginError(`\`${operation.name}\` returned lead form answers (personal data); set ${optInEnv}=1 to let agents read leads, or use a workflow node`, { kind: "permission_denied" });
    },
  });
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

const FIELD_ALIAS = /\.\s*as\s*\(/i;
const LEAD_FIELD_WORDS = /\bleads\b|field_data|custom_disclaimer_responses/i;

/**
 * Why a `fields` selection (or an api_request path and query) must be refused for an agent tool, if it must.
 * Graph field aliases (`field.as(other)`) rename fields, so any key-based guard could be bypassed with them.
 *
 * @param requestText - The `fields` value, or an api_request path plus query text (string)
 * @param leadsAllowed - Whether the leads opt-in is set (boolean)
 * @returns The problem, or undefined when the selection is fine (string | undefined)
 *
 * @example
 * describeFieldProblem("leads.as(x){field_data}", true); // "field aliases (.as(...)) are not allowed"
 */
export function describeFieldProblem(requestText, leadsAllowed) {
  const texts = [requestText, decodeRepeatedly(requestText)];
  if (texts.some((text) => FIELD_ALIAS.test(text))) return "field aliases (.as(...)) are not allowed";
  if (texts.some((text) => SECRET_WORDS.test(text))) return "tokens and secrets cannot be requested";
  if (!leadsAllowed && texts.some((text) => LEAD_FIELD_WORDS.test(text))) return "lead answers are personal data";
  return undefined;
}

/**
 * Returns the definition with every agent tool call's `fields` (and api_request's path and query) checked by
 * describeFieldProblem. Workflow nodes are unaffected.
 *
 * @param pluginDefinition - Definition (object)
 * @param leadsOptInEnv - e.g. "META_ADS_TOOL_ALLOW_LEADS" (string)
 * @returns A new definition (object)
 */
export function refuseUnsafeFieldsForTools(pluginDefinition, leadsOptInEnv) {
  const wrapOperation = (operation) => {
    const isApiRequest = operation.name === "api_request";
    if (!isApiRequest && !operation.parameters?.properties?.fields) return operation;
    const run = (context) => {
      if (context.source === "tool") {
        const args = context.args ?? {};
        const requestText = isApiRequest ? `${args.path ?? ""} ${JSON.stringify(args.query ?? {})}` : String(args.fields ?? "");
        const problem = describeFieldProblem(requestText, context.environment?.[leadsOptInEnv] === "1");
        if (problem) throw new PluginError(`\`${operation.name}\` as an agent tool: ${problem} in fields (leads need ${leadsOptInEnv}=1); use a workflow node`, { kind: "permission_denied" });
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

const AD_ACCOUNT_ID = /^(act_)?\d+$/;
const OBJECT_ID = /^\d+(_\d+)?$/;

/**
 * Returns the definition with path ids of agent tool calls checked: `ad_account_id` (and `object_id` of
 * `accountIdOperations`, e.g. insights) must be `act_<digits>` or digits, every other path id digits or
 * `<digits>_<digits>`. So `me`, `act_me` and `1/users` never reach Graph from an agent. Nodes are unaffected.
 *
 * @param pluginDefinition - Definition from defineRestPlugin, possibly wrapped (object)
 * @param accountIdOperations - Operations whose `object_id` may be an ad account (string[])
 * @returns A new definition (object)
 */
export function validateToolIds(pluginDefinition, accountIdOperations) {
  const pathParamsByOperation = new Map(
    (pluginDefinition.restSpec?.operations ?? []).map((operation) => [operation.name, Object.entries(operation.params).filter(([, paramSpec]) => paramSpec.in === "path").map(([paramName]) => paramName)]),
  );
  const wrapOperation = (operation) => {
    const pathParams = pathParamsByOperation.get(operation.name) ?? [];
    if (pathParams.length === 0) return operation;
    const patternFor = (paramName) => (paramName === "ad_account_id" || (paramName === "object_id" && accountIdOperations.includes(operation.name)) ? AD_ACCOUNT_ID : OBJECT_ID);
    const run = (context) => {
      if (context.source === "tool") {
        for (const paramName of pathParams) {
          const idValue = context.args?.[paramName];
          if (idValue !== undefined && !patternFor(paramName).test(String(idValue).trim())) {
            throw new PluginError(`\`${paramName}\` must be a numeric Meta id${patternFor(paramName) === AD_ACCOUNT_ID ? " (act_<number> or the number)" : ""}, got ${JSON.stringify(idValue)}`, { kind: "invalid_input" });
          }
        }
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}

/**
 * Whether a value holds lead answers at any depth.
 *
 * @param value - Operation data (any)
 * @returns True when a `field_data` or `custom_disclaimer_responses` key is present (boolean)
 */
export function containsLeadData(value) {
  if (Array.isArray(value)) return value.some(containsLeadData);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entryValue]) => LEAD_DATA_KEYS.has(key) || containsLeadData(entryValue));
}
