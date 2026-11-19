/**
 * The `Dropbox-API-Arg` header of Dropbox content endpoints (/files/download, /files/upload).
 *
 * Content endpoints take their JSON arguments in this one header instead of the body
 * (https://www.dropbox.com/developers/reference/json-encoding). The declarative layer places one param per header,
 * so an operation declares its Dropbox path as the header param `path` (wireName Dropbox-API-Arg) and its other
 * argument fields as ordinary params; `foldIntoApiArg` then moves all of them into one JSON value before the
 * request is built. The header must be ASCII, so every character from DEL (0x7F) up is written as `\uXXXX`.
 */

const NON_ASCII_OR_DEL = /[\u007f-￿]/g;

/**
 * Encodes Dropbox arguments as HTTP-header-safe JSON.
 *
 * @param apiArgument - Dropbox arguments, e.g. `{path: "/Café/a.txt"}` (object)
 * @returns JSON text using only printable ASCII (string)
 *
 * @example
 * encodeDropboxApiArg({ path: "/Café" }); // '{"path":"/Caf\\u00e9"}'
 */
export function encodeDropboxApiArg(apiArgument) {
  return JSON.stringify(apiArgument).replace(NON_ASCII_OR_DEL, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Wraps a content operation so `path` and the listed fields are sent as one `Dropbox-API-Arg` JSON header.
 * The folded fields are removed from the arguments, so they are never sent as query params.
 *
 * @param operation - Operation from defineRestPlugin with a header param `path` (object)
 * @param foldedFieldNames - Other argument names that belong in the header, e.g. ["mode", "autorename"] (string[])
 * @returns Operation whose run builds the header value (object)
 */
export function foldIntoApiArg(operation, foldedFieldNames = []) {
  return {
    ...operation,
    run: (context) => operation.run({ ...context, args: buildFoldedArgs(context.args, foldedFieldNames) }),
  };
}

function buildFoldedArgs(args, foldedFieldNames) {
  const apiArgument = { path: args.path };
  const remainingArgs = { ...args };
  for (const fieldName of foldedFieldNames) {
    if (remainingArgs[fieldName] !== undefined) apiArgument[fieldName] = remainingArgs[fieldName];
    delete remainingArgs[fieldName];
  }
  return { ...remainingArgs, path: encodeDropboxApiArg(apiArgument) };
}
