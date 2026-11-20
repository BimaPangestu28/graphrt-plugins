/**
 * google-sheets plugin definition: read and write Google Sheets through the
 * Sheets API v4, with OAuth (refresh token) or service account credentials.
 */
import { createSheetsClient } from "./lib/client.mjs";
import { GOOGLE_AUTH_ENV, resolveGoogleCredentials } from "./lib/google-auth.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { recordOperations } from "./operations/records.mjs";
import { spreadsheetOperations } from "./operations/spreadsheets.mjs";
import { valueOperations } from "./operations/values.mjs";

export const pluginDefinition = {
  name: "google-sheets",
  version: "0.1.0",
  description: "Google Sheets via the official Sheets API v4: spreadsheets, ranges, appends and header-based records",
  toolUserToken: { credentialEnv: GOOGLE_AUTH_ENV },
  tokenEnv: "GOOGLE_ACCESS_TOKEN",
  extraEnv: GOOGLE_AUTH_ENV,
  resolveAccessToken: resolveGoogleCredentials,
  createClient: createSheetsClient,
  operations: [
    ...spreadsheetOperations,
    ...valueOperations,
    ...recordOperations,
    createApiRequestOperation({ apiName: "Google Sheets API", examplePath: "/spreadsheets/{spreadsheet_id}/values/Sheet1!A1:B2" }),
  ],
};
