/**
 * google-calendar plugin definition: calendars, free/busy and free-slot search, and events through
 * the Google Calendar API v3, with OAuth (refresh token) or service account credentials.
 */
import { createCalendarClient } from "./lib/client.mjs";
import { GOOGLE_AUTH_ENV, resolveGoogleCredentials } from "./lib/google-auth.mjs";
import { TOOL_ALLOWED_IDS_ENV, TOOL_SEND_UPDATES_ENV } from "./lib/tool-policy.mjs";
import { apiRequestOperation } from "./operations/api-request.mjs";
import { calendarOperations } from "./operations/calendars.mjs";
import { eventOperations } from "./operations/events.mjs";

export const pluginDefinition = {
  name: "google-calendar",
  version: "0.1.0",
  description: "Google Calendar via the official Calendar API v3: calendars, free/busy, free-slot search and events with Google Meet",
  toolUserToken: { credentialEnv: GOOGLE_AUTH_ENV },
  tokenEnv: "GOOGLE_ACCESS_TOKEN",
  extraEnv: [...GOOGLE_AUTH_ENV, TOOL_ALLOWED_IDS_ENV, TOOL_SEND_UPDATES_ENV],
  resolveAccessToken: resolveGoogleCredentials,
  createClient: createCalendarClient,
  operations: [...calendarOperations, ...eventOperations, apiRequestOperation],
};
