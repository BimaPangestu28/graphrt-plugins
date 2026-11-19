/**
 * ZeroBounce v2 takes the API key as the `api_key` query parameter, except on two endpoints that read it from the
 * body: validatebatch (JSON) and sendfile (a multipart field). The declarative layer only places credentials in
 * the query or headers, so for those operations this module
 * 1. adds a body param `api_key` to the operation spec (addBodyApiKeyParam), and
 * 2. after defineRestPlugin, removes it from the operation's public parameters (callers and agents never see or set
 *    it) and fills it from the run's credential, the same value the layer puts in the query and redacts
 *    everywhere (injectBodyApiKey).
 *
 * The credential is captured where the layer creates the run's client (definition.createClient receives the
 * resolved access token) and kept in a WeakMap keyed by that client, so it never travels through arguments.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const BODY_API_KEY_PARAM = "api_key";

/**
 * Adds the hidden `api_key` body param to an operation spec.
 *
 * @param operationSpec - Declarative operation spec (object)
 * @returns Spec with `params.api_key` (object)
 */
export function addBodyApiKeyParam(operationSpec) {
  return { ...operationSpec, params: { ...operationSpec.params, [BODY_API_KEY_PARAM]: { in: "body", type: "string", description: "Set by the plugin from ZEROBOUNCE_API_KEY" } } };
}

function withoutApiKeyParameter(parameters) {
  const { [BODY_API_KEY_PARAM]: _hidden, ...properties } = parameters.properties;
  return { ...parameters, properties, required: parameters.required.filter((name) => name !== BODY_API_KEY_PARAM) };
}

/**
 * Hides `api_key` from the named operations and fills it from the run's credential.
 *
 * @param definition - Definition from defineRestPlugin (object)
 * @param operationNames - Operations whose spec went through addBodyApiKeyParam (string[])
 * @returns Definition with a credential-capturing createClient and wrapped operations (object)
 * @throws Error - An operation name does not exist (a typo in the plugin)
 */
export function injectBodyApiKey(definition, operationNames) {
  const missingName = operationNames.find((operationName) => !definition.operations.some((operation) => operation.name === operationName));
  if (missingName) throw new Error(`${definition.name}: no operation \`${missingName}\` for the body api_key`);
  const credentialsByClient = new WeakMap();
  const createClient = (clientOptions) => {
    const client = definition.createClient(clientOptions);
    credentialsByClient.set(client, clientOptions.accessToken);
    return client;
  };
  const wrapOperation = (operation) => ({
    ...operation,
    parameters: withoutApiKeyParameter(operation.parameters),
    run: (context) => {
      const credential = credentialsByClient.get(context.client);
      if (!credential) throw new PluginError("ZEROBOUNCE_API_KEY is not set", { kind: "auth_error" });
      return operation.run({ ...context, args: { ...context.args, [BODY_API_KEY_PARAM]: credential } });
    },
  });
  const operations = definition.operations.map((operation) => (operationNames.includes(operation.name) ? wrapOperation(operation) : operation));
  return { ...definition, createClient, operations };
}
