/**
 * Guard for `people` properties set by agent tools. Assigning a person to a page notifies them in Notion, so a
 * tool call may only do it when the operator opts in with NOTION_TOOL_ALLOW_PEOPLE=1. Workflow nodes are not
 * restricted.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const ALLOW_PEOPLE_ENV = "NOTION_TOOL_ALLOW_PEOPLE";

/**
 * Refuses a tool call that would set a people property, unless NOTION_TOOL_ALLOW_PEOPLE=1.
 *
 * @param context - `{source, environment}` of the operation run (object)
 * @param propertyValues - Raw Notion JSON (`{name: {people: [...]}}`) or plain `values` (object, optional)
 * @param propertyTypes - `{name: type}` when checking plain `values` (object, optional)
 * @throws PluginError kind `permission_denied` - A tool call sets a people property without the opt-in
 *
 * @example
 * assertPeopleWritesAllowed({ source: "tool", environment: {} }, { Owner: { people: [] } }); // throws permission_denied
 */
export function assertPeopleWritesAllowed({ source, environment }, propertyValues, propertyTypes) {
  if (source !== "tool" || environment?.[ALLOW_PEOPLE_ENV] === "1" || !propertyValues) return;
  const peopleNames = Object.entries(propertyValues)
    .filter(([propertyName, propertyValue]) => (propertyTypes ? propertyTypes[propertyName] === "people" : isRawPeopleValue(propertyValue)))
    .map(([propertyName]) => propertyName);
  if (peopleNames.length === 0) return;
  throw new PluginError(
    `Setting people properties (${peopleNames.join(", ")}) notifies those people, so agent tools may not do it unless ${ALLOW_PEOPLE_ENV}=1 is set; use a workflow node instead`,
    { kind: "permission_denied" },
  );
}

function isRawPeopleValue(propertyValue) {
  return Boolean(propertyValue) && typeof propertyValue === "object" && (Object.hasOwn(propertyValue, "people") || propertyValue.type === "people");
}
