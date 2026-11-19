/**
 * Typeform API host. US accounts use api.typeform.com; EU accounts must read responses from api.eu.typeform.com,
 * or api.typeform.eu for the new EU data center (a wrong region returns empty results, not an error). See
 * https://www.typeform.com/developers/get-started/responses-data-center/.
 */
export const BASE_URL_ENV = "TYPEFORM_BASE_URL";
const DEFAULT_BASE_URL = "https://api.typeform.com";
const ALLOWED_BASE_URLS = new Set([DEFAULT_BASE_URL, "https://api.eu.typeform.com", "https://api.typeform.eu"]);

/**
 * Reads and checks TYPEFORM_BASE_URL (the layer turns a throw into an invalid_input error).
 *
 * @param environment - Environment variables (object)
 * @returns One of the three Typeform API origins, without a trailing slash (string)
 * @throws Error - When the value is not one of the allowed origins
 *
 * @example
 * resolveTypeformBaseUrl({ TYPEFORM_BASE_URL: "https://api.eu.typeform.com" }); // "https://api.eu.typeform.com"
 */
export function resolveTypeformBaseUrl(environment) {
  const configured = environment?.[BASE_URL_ENV]?.trim().replace(/\/$/, "");
  if (!configured) return DEFAULT_BASE_URL;
  if (!ALLOWED_BASE_URLS.has(configured)) throw new Error(`${BASE_URL_ENV} must be one of ${[...ALLOWED_BASE_URLS].join(", ")}`);
  return configured;
}
