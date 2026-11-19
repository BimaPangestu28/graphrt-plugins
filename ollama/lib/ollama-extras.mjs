/**
 * Small additions to the declarative ollama plugin:
 *   - an optional bearer token (OLLAMA_API_KEY) for servers behind an authenticating proxy; Ollama itself has no auth,
 *     so without the env nothing is sent;
 *   - `think` as a boolean or a level ("low" | "medium" | "high"). A declarative param has one type, so the schema is
 *     replaced and template strings "true"/"false" become booleans before the request is built.
 */
export const API_KEY_ENV = "OLLAMA_API_KEY";
const THINK_LEVELS = ["low", "medium", "high"];
const THINK_SCHEMA = {
  enum: [true, false, "true", "false", ...THINK_LEVELS],
  description: 'Thinking models: true/false, or a level "low" | "medium" | "high" (gpt-oss); thinking is returned separately',
};

/**
 * Custom auth hook: sets `Authorization: Bearer` from a node's access_token or OLLAMA_API_KEY, when there is one.
 *
 * @param request - `{headers, credential, environment}` from the declarative layer (object)
 * @returns Secrets to redact (string[])
 */
export function authorizeOptionalBearer({ headers, credential, environment }) {
  const apiKey = credential || environment?.[API_KEY_ENV]?.trim();
  if (!apiKey) return [];
  headers.authorization = `Bearer ${apiKey}`;
  return [apiKey];
}

/**
 * Lets an operation's `think` param take a boolean or a level.
 *
 * @param operation - Operation from defineRestPlugin with a `think` param (object)
 * @returns Operation with the wider schema and a run that turns "true"/"false" into booleans (object)
 */
export function acceptThinkLevels(operation) {
  const parameters = { ...operation.parameters, properties: { ...operation.parameters.properties, think: THINK_SCHEMA } };
  return {
    ...operation,
    parameters,
    run: (context) => operation.run({ ...context, args: { ...context.args, ...normalizeThink(context.args.think) } }),
  };
}

function normalizeThink(think) {
  if (think === undefined) return {};
  if (think === "true" || think === "false") return { think: think === "true" };
  return { think };
}
