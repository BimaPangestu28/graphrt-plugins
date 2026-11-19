/**
 * `search` puts the query into an OData function call, `root/search(q='<query>')`, where a single quote ends the
 * string. OData escapes it by doubling (https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part2-url-conventions.html),
 * so `wrapSearchQuery` doubles quotes before the path is built; the layer then percent-encodes the segment.
 */

/**
 * Escapes a value for an OData string literal.
 *
 * @param text - Raw text (string)
 * @returns Text with every `'` doubled (string)
 *
 * @example
 * escapeODataString("Ada's"); // "Ada''s"
 */
export function escapeODataString(text) {
  return String(text).replaceAll("'", "''");
}

/**
 * Wraps the search operation so its `query` arg is OData-escaped.
 *
 * @param operation - Operation with a `query` path param (object)
 * @returns Operation (object)
 */
export function wrapSearchQuery(operation) {
  return { ...operation, run: (context) => operation.run({ ...context, args: { ...context.args, query: escapeODataString(context.args.query) } }) };
}
