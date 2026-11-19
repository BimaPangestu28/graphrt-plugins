/**
 * Slack accepts GET for write methods too (`GET /chat.postMessage?channel=...&text=...` posts a message), so the
 * layer's "api_request is GET-only for tools" rule is not enough here. For agent tools, api_request may only call
 * Slack methods whose name says they read: `*.list`, `*.info`, `*.history`, `*.replies`, `*.get*`, `*.lookup*`
 * (except files.getUploadURLExternal). Workflow nodes are unaffected.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const READ_METHOD_PATTERN = /^\/[A-Za-z]+(\.[A-Za-z]+)*\.(list|info|history|replies|get[A-Za-z]*|lookup[A-Za-z]*)\/?$/;
const REFUSED_READ_LOOKALIKES = new Set(["/files.getuploadurlexternal"]);

/**
 * Whether a Slack Web API path names a read method.
 *
 * @param path - api_request `path`, e.g. "/team.info?team=T1" (string)
 * @returns True for read methods (boolean)
 *
 * @example
 * isSlackReadMethodPath("/conversations.members"); // false
 * isSlackReadMethodPath("/team.info"); // true
 */
export function isSlackReadMethodPath(path) {
  const pathname = String(path).split(/[?#]/)[0];
  return READ_METHOD_PATTERN.test(pathname) && !REFUSED_READ_LOOKALIKES.has(pathname.toLowerCase().replace(/\/$/, ""));
}

/**
 * Wraps the generated api_request so tool calls can only reach read methods.
 *
 * @param apiRequestOperation - Generated api_request operation (object)
 * @returns Operation with the same schema and a guarded run (object)
 */
export function restrictApiRequestForTools(apiRequestOperation) {
  return {
    ...apiRequestOperation,
    description: `${apiRequestOperation.description} Agent tools may only call read methods (*.list, *.info, *.history, *.replies, *.get*, *.lookup*).`,
    run: (context) => {
      if (context.source === "tool" && !isSlackReadMethodPath(context.args?.path ?? "")) {
        throw new PluginError("api_request as an agent tool only calls Slack read methods (*.list, *.info, *.history, *.replies, *.get*, *.lookup*); Slack also runs writes sent as GET", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
