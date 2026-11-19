/**
 * Omits message bodies from what agent tools read back. Sent transactional emails often hold password-reset
 * links, one-time codes and magic-login URLs, so an agent that can read them could take over accounts. Tool
 * results keep everything else (recipients, subject, status, events); the named fields are replaced by a note.
 * Workflow nodes get the full response.
 *
 * Brevo needs no copy: its tool operations return no sent-email bodies, and its api_request allowlist leaves out
 * /smtp/emails.
 */

export const OMITTED_FOR_TOOLS = "[omitted for agent tools: message bodies can hold reset links and codes; read it from a workflow node]";

/**
 * Replaces the named fields, at any depth, with OMITTED_FOR_TOOLS.
 *
 * @param value - Response data (any)
 * @param fieldNames - Field names to omit, e.g. Set(["html", "text"]) (Set<string>)
 * @returns A copy without those fields' contents (any)
 *
 * @example
 * omitFields({ subject: "Hi", html: "<p>code 1</p>" }, new Set(["html"])); // { subject: "Hi", html: "[omitted ...]" }
 */
export function omitFields(value, fieldNames) {
  if (Array.isArray(value)) return value.map((item) => omitFields(item, fieldNames));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => [key, fieldNames.has(key) && fieldValue !== null && fieldValue !== undefined ? OMITTED_FOR_TOOLS : omitFields(fieldValue, fieldNames)]),
  );
}

/**
 * Wraps an operation so tool calls get its data without the named body fields.
 *
 * @param operation - Operation (object)
 * @param fieldNames - Field names to omit for tools (string[])
 * @returns Operation with the same schema (object)
 */
export function omitBodyFieldsForTools(operation, fieldNames) {
  const fieldNameSet = new Set(fieldNames);
  return {
    ...operation,
    description: `${operation.description} (agent tools get ${fieldNames.join("/")} omitted)`,
    run: async (context) => {
      const result = await operation.run(context);
      if (context.source !== "tool" || !result) return result;
      return { ...result, data: omitFields(result.data, fieldNameSet) };
    },
  };
}
