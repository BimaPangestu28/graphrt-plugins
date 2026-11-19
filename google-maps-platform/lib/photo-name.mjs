/**
 * get_place_photo's path keeps slashes (`/{+photo_name}/media`), so a free-form name could reach any Places API
 * path. Only the documented photo resource name `places/<place id>/photos/<photo reference>` is accepted.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const PHOTO_NAME_PATTERN = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

/**
 * Returns the definition with the photo operation's `photo_name` checked against the photo resource name shape.
 *
 * @param pluginDefinition - Plugin definition (object)
 * @param operationName - The photo operation (string)
 * @returns A new definition (object)
 * @throws PluginError kind `invalid_input` - At call time, for a name of another shape
 */
export function requirePhotoName(pluginDefinition, operationName) {
  const wrapOperation = (operation) => {
    if (operation.name !== operationName) return operation;
    const run = (context) => {
      if (!PHOTO_NAME_PATTERN.test(String(context.args.photo_name))) {
        throw new PluginError(`photo_name must look like places/<place id>/photos/<photo id> (a photos[].name from get_place); got ${JSON.stringify(context.args.photo_name)}`, { kind: "invalid_input" });
      }
      return operation.run(context);
    };
    return { ...operation, run };
  };
  return { ...pluginDefinition, operations: pluginDefinition.operations.map(wrapOperation) };
}
