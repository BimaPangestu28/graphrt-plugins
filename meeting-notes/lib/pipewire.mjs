/**
 * Who captures the microphone, from `pw-dump`'s JSON (PipeWire's object list), and running PipeWire's tools.
 *
 * A mic user is a `Stream/Input/Audio` node fed by a link from an `Audio/Source*` node (a real microphone). Captures
 * of a sink monitor (`Audio/Sink`, the computer's sound) do not count, nor do this plugin's own recorder streams
 * (`node.name` starting with OWN_STREAM_PREFIX) or this process.
 */
import { pluginError } from "./errors.mjs";

export const OWN_STREAM_PREFIX = "graphrt-meeting-";

function textProperty(properties, key) {
  const value = properties?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberProperty(properties, key) {
  const value = properties?.[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Parses pw-dump output into mic users, in stream id order.
 *
 * @param json - pw-dump stdout (string)
 * @param ownPid - This process's pid, skipped (number)
 * @returns `[{stream_id, app_name, binary, pid}]` (Array<object>)
 * @throws PluginError kind `api_error` - When the text is not pw-dump's array of objects
 */
export function parseMicUsers(json, ownPid) {
  let objects;
  try {
    objects = JSON.parse(json);
  } catch (parseError) {
    throw pluginError("api_error", `pw-dump output is not JSON: ${parseError.message}`);
  }
  if (!Array.isArray(objects)) throw pluginError("api_error", "pw-dump output is not a list of objects");
  const nodes = new Map();
  const clients = new Map();
  const links = [];
  for (const object of objects) {
    const id = numberProperty(object, "id");
    if (id === null || typeof object.type !== "string") continue;
    if (object.type.endsWith(":Link")) {
      const output = numberProperty(object.info, "output-node-id");
      const input = numberProperty(object.info, "input-node-id");
      if (output !== null && input !== null) links.push([output, input]);
      continue;
    }
    const properties = object.info?.props;
    if (!properties || typeof properties !== "object") continue;
    if (object.type.endsWith(":Node")) nodes.set(id, properties);
    else if (object.type.endsWith(":Client")) clients.set(id, properties);
  }
  const fedByMicrophone = new Set(
    links.filter(([output]) => (textProperty(nodes.get(output), "media.class") ?? "").startsWith("Audio/Source")).map(([, input]) => input),
  );
  const users = [];
  for (const streamId of [...fedByMicrophone].sort((left, right) => left - right)) {
    const stream = nodes.get(streamId);
    if (!stream || textProperty(stream, "media.class") !== "Stream/Input/Audio") continue;
    if ((textProperty(stream, "node.name") ?? "").startsWith(OWN_STREAM_PREFIX)) continue;
    const client = clients.get(numberProperty(stream, "client.id"));
    const fromStreamOrClient = (key) => textProperty(stream, key) ?? textProperty(client, key);
    const pid = numberProperty(stream, "application.process.id") ?? numberProperty(client, "application.process.id") ?? numberProperty(client, "pipewire.sec.pid");
    if (pid === ownPid) continue;
    users.push({
      stream_id: streamId,
      app_name: fromStreamOrClient("application.name") ?? textProperty(stream, "node.name") ?? "Unknown program",
      binary: fromStreamOrClient("application.process.binary"),
      pid,
    });
  }
  return users;
}

/**
 * The environment for PipeWire's tools. graphrt starts plugins with a clean environment, so the user's runtime
 * directory (where PipeWire's socket lives) is filled in from the uid when it is missing.
 *
 * @param environment - Plugin environment (object)
 * @param uid - User id (number)
 * @returns Environment for pw-dump / pw-record (object)
 */
export function pipewireEnvironment(environment, uid) {
  const runtimeDirectory = environment.XDG_RUNTIME_DIR || (Number.isInteger(uid) ? `/run/user/${uid}` : undefined);
  return { PATH: environment.PATH ?? "/usr/bin:/bin", HOME: environment.HOME ?? "", ...(runtimeDirectory ? { XDG_RUNTIME_DIR: runtimeDirectory } : {}) };
}
