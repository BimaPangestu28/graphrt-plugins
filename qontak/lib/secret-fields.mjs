/**
 * Channel integration records can carry provider credentials and webhook settings (access tokens, app secrets,
 * webhook URLs, auth headers). Agent tools get the records with those values replaced by "[removed]"; workflow
 * nodes get everything. Removed:
 * - fields whose key looks secret (token, secret, password, api key, bearer, auth..., credential, webhook, ...);
 * - the `value` of `{key|name: <secret-looking name>, value}` pairs (header and setting lists);
 * - anything nested deeper than MAX_DEPTH, which is dropped rather than returned unchecked.
 */
const SECRET_FIELD_PATTERN = /(token|secret|password|passwd|pwd|api[_-]?key|apikey|private|credential|webhook|signature|bearer|^auth|authori[sz]ation|cookie|session)/i;
const PAIR_NAME_FIELDS = ["key", "name"];
const MAX_DEPTH = 20;
const TOO_DEEP = "[removed: too deep]";

function isSecretPair(record) {
  if (!Object.hasOwn(record, "value")) return false;
  return PAIR_NAME_FIELDS.some((nameField) => typeof record[nameField] === "string" && SECRET_FIELD_PATTERN.test(record[nameField]));
}

/**
 * Replaces secret-looking fields (by key name) anywhere in a value.
 *
 * @param value - Any JSON value (any)
 * @param depth - Current nesting depth (number, internal)
 * @returns Copy with secret fields replaced (any)
 *
 * @example
 * stripSecretFields({ id: "i1", settings: { access_token: "x" } }); // { id: "i1", settings: { access_token: "[removed]" } }
 */
export function stripSecretFields(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return TOO_DEEP;
  if (Array.isArray(value)) return value.map((item) => stripSecretFields(item, depth + 1));
  const secretPair = isSecretPair(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => {
      const isSecret = SECRET_FIELD_PATTERN.test(key) || (secretPair && key === "value");
      return [key, isSecret ? "[removed]" : stripSecretFields(fieldValue, depth + 1)];
    }),
  );
}

/**
 * Wraps an operation so tool results are stripped of secret-looking fields.
 *
 * @param operation - Operation (object)
 * @returns Operation (object)
 */
export function stripSecretFieldsForTools(operation) {
  return {
    ...operation,
    run: async (context) => {
      const result = await operation.run(context);
      return context.source === "tool" ? { ...result, data: stripSecretFields(result?.data) } : result;
    },
  };
}
