/**
 * Finds node config properties that graphrt takes from workflow nodes itself (id, type, title, data, timeout, ...;
 * see shared/lib/reserved-node-keys.mjs). Such a property can never be set from a node. Used by
 * scripts/check-reserved-parameters.mjs for the repo's manifests and by the community plugin ingest for the
 * manifest inside a third-party tarball.
 */
import { isReservedNodeKey } from "../../shared/lib/reserved-node-keys.mjs";

/**
 * Lists `<plugin> <node kind>: <property>` for every reserved node config property in one manifest.
 *
 * @param pluginName - Plugin name, for the report (string)
 * @param manifest - Parsed graphrt-plugin.json (object)
 * @returns Offender descriptions; empty when there are none (string[])
 */
export function findReservedNodeProperties(pluginName, manifest) {
  return (manifest.nodes ?? []).flatMap((nodeDescriptor) =>
    Object.keys(nodeDescriptor.config_schema?.properties ?? {})
      .filter(isReservedNodeKey)
      .map((propertyName) => `${pluginName} ${nodeDescriptor.kind}: \`${propertyName}\``),
  );
}
