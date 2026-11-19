/**
 * sentry plugin definition: organizations, projects, issues, events and releases through the Sentry web API
 * (https://docs.sentry.io/api/), with resolve/ignore/assign for issues. SaaS only (us or de data region).
 * Built with the declarative REST layer (docs/declarative-plugins.md) plus a small pagination fix (lib/empty-page.mjs).
 *
 * Agent policy: reads are tools; issue updates (resolve, ignore, assign) need SENTRY_TOOL_ALLOW_WRITE=1 for tools;
 * deleting issues is node only; api_request cannot reach service hooks as a tool.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { endPaginationOnEmptyPage } from "./lib/empty-page.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";

const WRITE_OPT_IN = "optIn:SENTRY_TOOL_ALLOW_WRITE";
const REGIONS = ["us", "de"];
const LINK_PAGES = { nextLinkHeader: true, limitParam: "per_page", maxLimit: 100 };
// Service hooks return their signing secret: not for agent tools through api_request.
const TOOL_API_BLOCKED_PATHS = [/(^|\/)hooks(\/|$)/];

/**
 * Resolves the regional API base URL from SENTRY_REGION (us or de, default us).
 *
 * @param environment - Plugin environment (object)
 * @returns `https://<region>.sentry.io/api/0` (string)
 * @throws Error - Unknown region (becomes invalid_input)
 */
export function resolveSentryApiUrl(environment) {
  const region = (environment.SENTRY_REGION?.trim() || "us").toLowerCase();
  if (!REGIONS.includes(region)) throw new Error(`SENTRY_REGION must be one of ${REGIONS.join(", ")} (your organization's data storage location)`);
  return `https://${region}.sentry.io/api/0`;
}

const organizationParam = { in: "path", type: "string", required: true, description: "Organization slug or id" };
const projectParam = { in: "path", type: "string", required: true, description: "Project slug or id" };
const issueIdParam = { in: "path", type: "string", required: true, description: "Issue id (numeric, from list_issues)" };
const eventIdParam = { in: "path", type: "string", required: true, description: 'Event id (32 hex), or "latest", "oldest", "recommended"' };
const statsPeriodParam = { in: "query", type: "string", wireName: "statsPeriod", description: "Time window, e.g. 24h, 14d (default 14d for issues)" };
const environmentParam = { in: "query", type: "array", items: { type: "string" }, style: "repeat", maxItems: 20, description: "Only these environments" };
const issueParams = { organization: organizationParam, issue_id: issueIdParam };

// --- organizations, projects, releases ----------------------------------------------------------------

const organizationOperations = [
  {
    name: "list_organizations",
    title: "List organizations",
    description: "Organizations the token can access (slug for other calls)",
    path: "/organizations/",
    params: { owner: { in: "query", type: "boolean", description: "Only organizations you own" }, query: { in: "query", type: "string" } },
    response: LINK_PAGES,
  },
  {
    name: "list_projects",
    title: "List projects",
    description: "Projects of an organization",
    path: "/organizations/{organization}/projects/",
    params: { organization: organizationParam, query: { in: "query", type: "string", description: "Filter by name or slug" } },
    response: LINK_PAGES,
  },
  {
    name: "list_releases",
    title: "List releases",
    description: "Releases of an organization, newest first",
    path: "/organizations/{organization}/releases/",
    params: {
      organization: organizationParam,
      project: { in: "query", type: "string", description: "Project id" },
      environment: environmentParam,
      query: { in: "query", type: "string", description: "Version starts with" },
    },
    response: LINK_PAGES,
  },
];

// --- issues and events ----------------------------------------------------------------------------------

const issueReadOperations = [
  {
    name: "list_issues",
    title: "List issues",
    description: 'Issues of an organization; query uses Sentry search syntax, default "is:unresolved"',
    path: "/organizations/{organization}/issues/",
    params: {
      organization: organizationParam,
      query: { in: "query", type: "string", default: "is:unresolved", description: 'e.g. "is:unresolved level:error assigned:me"; "" for all' },
      project: { in: "query", type: "array", items: { type: "string" }, style: "repeat", maxItems: 50, description: "Project ids or slugs" },
      environment: environmentParam,
      stats_period: statsPeriodParam,
      sort: { in: "query", type: "string", enum: ["date", "freq", "inbox", "new", "recommended", "trends", "user"], description: "date = last seen (default)" },
    },
    response: { nextLinkHeader: true, limitParam: "limit", maxLimit: 100, defaultLimit: 25 },
  },
  {
    name: "get_issue",
    title: "Get issue",
    description: "One issue: title, culprit, level, status, counts, first/last seen, assignee",
    path: "/organizations/{organization}/issues/{issue_id}/",
    params: issueParams,
  },
  {
    name: "list_issue_events",
    title: "List issue events",
    description: "Events of an issue, newest first",
    path: "/organizations/{organization}/issues/{issue_id}/events/",
    params: {
      ...issueParams,
      full: { in: "query", type: "boolean", description: "Include the full event body (stack traces)" },
      query: { in: "query", type: "string" },
      environment: environmentParam,
      stats_period: statsPeriodParam,
    },
    response: LINK_PAGES,
  },
  {
    name: "get_issue_event",
    title: "Get issue event",
    description: "One event of an issue with stack trace, breadcrumbs, tags and context (use latest for the newest)",
    path: "/organizations/{organization}/issues/{issue_id}/events/{event_id}/",
    params: { ...issueParams, event_id: eventIdParam, environment: environmentParam },
  },
  {
    name: "list_project_events",
    title: "List project events",
    description: "Recent error events of a project",
    path: "/projects/{organization}/{project}/events/",
    params: { organization: organizationParam, project: projectParam, full: { in: "query", type: "boolean" }, stats_period: statsPeriodParam },
    response: { nextLinkHeader: true },
  },
  {
    name: "get_project_event",
    title: "Get project event",
    description: "One event by id within a project",
    path: "/projects/{organization}/{project}/events/{event_id}/",
    params: { organization: organizationParam, project: projectParam, event_id: { ...eventIdParam, description: "Event id (32 hex)" } },
  },
];

// --- issue writes ------------------------------------------------------------------------------------------

const issueWriteOperations = [
  {
    name: "update_issue",
    title: "Update issue",
    description: "Change an issue's status, assignee, priority, bookmark or seen flag",
    method: "PUT",
    path: "/organizations/{organization}/issues/{issue_id}/",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: {
      ...issueParams,
      status: { in: "body", type: "string", enum: ["resolved", "resolvedInNextRelease", "unresolved", "ignored"] },
      assigned_to: { in: "body", type: "string", wireName: "assignedTo", description: 'user:<id>, team:<id>, a username or email; "" to unassign' },
      priority: { in: "body", type: "string", enum: ["low", "medium", "high"] },
      has_seen: { in: "body", type: "boolean", wireName: "hasSeen" },
      is_bookmarked: { in: "body", type: "boolean", wireName: "isBookmarked" },
    },
  },
  {
    name: "resolve_issue",
    title: "Resolve issue",
    description: "Mark an issue resolved now, in the next release, or in a given release",
    method: "PUT",
    path: "/organizations/{organization}/issues/{issue_id}/",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: {
      ...issueParams,
      in_next_release: { in: "body", type: "boolean", wireName: "statusDetails.inNextRelease", description: "Resolve in the next release" },
      in_release: { in: "body", type: "string", wireName: "statusDetails.inRelease", description: 'Release version, or "latest"' },
    },
    constants: { body: { status: "resolved" } },
  },
  {
    name: "ignore_issue",
    title: "Ignore (archive) issue",
    description: "Archive an issue: forever, until it escalates, for some minutes, or until it reaches a count",
    method: "PUT",
    path: "/organizations/{organization}/issues/{issue_id}/",
    write: "idempotent",
    toolPolicy: WRITE_OPT_IN,
    params: {
      ...issueParams,
      substatus: { in: "body", type: "string", enum: ["archived_until_escalating", "archived_until_condition_met", "archived_forever"], description: "How long to archive (Sentry picks when omitted)" },
      ignore_duration: { in: "body", type: "integer", min: 1, wireName: "statusDetails.ignoreDuration", description: "Minutes to ignore (use with archived_until_condition_met)" },
      ignore_count: { in: "body", type: "integer", min: 1, wireName: "statusDetails.ignoreCount", description: "Unarchive after this many more events" },
      ignore_window: { in: "body", type: "integer", min: 1, wireName: "statusDetails.ignoreWindow", description: "Minutes for ignore_count" },
      ignore_user_count: { in: "body", type: "integer", min: 1, wireName: "statusDetails.ignoreUserCount" },
      ignore_user_window: { in: "body", type: "integer", min: 1, wireName: "statusDetails.ignoreUserWindow" },
    },
    constants: { body: { status: "ignored" } },
  },
  {
    name: "delete_issue",
    title: "Delete issue",
    description: "Delete an issue and its events",
    method: "DELETE",
    path: "/organizations/{organization}/issues/{issue_id}/",
    write: "idempotent",
    nodeOnly: true,
    params: issueParams,
  },
];

const restDefinition = defineRestPlugin({
  name: "sentry",
  version: "0.1.0",
  description: "Sentry: organizations, projects, issues (list, get, resolve, ignore, assign), events with stack traces and releases",
  apiName: "Sentry API",
  baseUrl: resolveSentryApiUrl,
  allowedHostSuffix: ".sentry.io",
  extraEnv: ["SENTRY_REGION"],
  auth: { type: "bearer", env: "SENTRY_AUTH_TOKEN" },
  // Errors are {"detail": "..."}; validation errors are {"field": ["..."]}.
  errors: { messagePath: ["detail", "detail.message", "status.0", "statusDetails.0"] },
  apiRequest: { examplePath: "/organizations/acme/stats_v2/" },
  operations: [...organizationOperations, ...issueReadOperations, ...issueWriteOperations],
});

const guardedDefinition = guardToolApiRequest(restDefinition, { blockedPaths: TOOL_API_BLOCKED_PATHS, reason: "service hooks carry signing secrets; use a workflow node" });

export const pluginDefinition = endPaginationOnEmptyPage(guardedDefinition);
