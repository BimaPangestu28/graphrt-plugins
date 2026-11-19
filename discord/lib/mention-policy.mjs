/**
 * Mass-mention guard for agent tools. Discord pings only what `allowed_mentions` permits
 * (https://discord.com/developers/docs/resources/message#allowed-mentions-object); the plugin's default permits
 * nothing. A tool call may widen that to users, but pinging @everyone/@here (`parse: ["everyone"]`) or roles
 * (`parse: ["roles"]` or a `roles` id list) notifies a whole server, so it needs DISCORD_TOOL_ALLOW_MASS_MENTIONS=1.
 * Workflow nodes are not limited.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MASS_MENTIONS_ENV = "DISCORD_TOOL_ALLOW_MASS_MENTIONS";
const MASS_PARSE_TYPES = new Set(["everyone", "roles"]);

/**
 * Whether an allowed_mentions object lets the message ping @everyone, @here or roles.
 *
 * @param allowedMentions - allowed_mentions argument (object, optional)
 * @returns True for mass mentions (boolean)
 *
 * @example
 * allowsMassMentions({ parse: ["users"] }); // false
 * allowsMassMentions({ roles: ["123"] }); // true
 */
export function allowsMassMentions(allowedMentions) {
  if (!allowedMentions || typeof allowedMentions !== "object") return false;
  const parseTypes = Array.isArray(allowedMentions.parse) ? allowedMentions.parse : [];
  const hasRoleIds = Array.isArray(allowedMentions.roles) && allowedMentions.roles.length > 0;
  return hasRoleIds || parseTypes.some((parseType) => MASS_PARSE_TYPES.has(String(parseType).toLowerCase()));
}

/**
 * Wraps send_message so tool calls with mass mentions need the opt-in.
 *
 * @param operation - Generated send_message operation (object)
 * @returns Operation with a guarded run (object)
 */
export function guardMassMentions(operation) {
  return {
    ...operation,
    run: (context) => {
      const isAllowed = context.source !== "tool" || context.environment?.[MASS_MENTIONS_ENV] === "1" || !allowsMassMentions(context.args.allowed_mentions);
      if (!isAllowed) {
        throw new PluginError(`Agent tools may not ping @everyone, @here or roles; set ${MASS_MENTIONS_ENV}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
      }
      return operation.run(context);
    },
  };
}
