/**
 * Copied from microsoft-graph/lib/graph-tenant.mjs (keep the two in step).
 *
 * Microsoft identity platform tenants for a declarative Graph plugin.
 *
 * The declarative layer takes a fixed OAuth token URL, but Microsoft's depends on the tenant
 * (`https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`): single-tenant apps must use their own tenant
 * id, multi-tenant apps may use `common` or `organizations`. So the plugin defines its spec once per tenant (from
 * MICROSOFT_TENANT_ID, default `common`) and picks the matching client at run time. Operations are the same code
 * for every tenant; only the client's token URL differs.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { defineRestPlugin } from "./shared/rest-plugin.mjs";

export const TENANT_ENV = "MICROSOFT_TENANT_ID";
export const DEFAULT_TENANT = "common";
// A GUID, a verified domain (contoso.onmicrosoft.com) or common/organizations/consumers.
const TENANT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$/;

/**
 * Builds the token URL for a tenant.
 *
 * @param tenant - Tenant id, domain, or common/organizations/consumers (string)
 * @returns Token URL (string)
 *
 * @example
 * buildTokenUrl("common"); // "https://login.microsoftonline.com/common/oauth2/v2.0/token"
 */
export function buildTokenUrl(tenant) {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

/**
 * Reads and checks MICROSOFT_TENANT_ID.
 *
 * @param environment - Environment variables (object)
 * @returns The tenant, `common` when unset (string)
 * @throws PluginError kind `invalid_input` - When the value is not a tenant id or domain
 */
export function readTenant(environment) {
  const tenant = environment?.[TENANT_ENV]?.trim() || DEFAULT_TENANT;
  if (!TENANT_PATTERN.test(tenant) || tenant.includes("..")) {
    throw new PluginError(`${TENANT_ENV} must be a tenant id (GUID), a domain such as contoso.onmicrosoft.com, or common/organizations`, { kind: "invalid_input" });
  }
  return tenant;
}

/**
 * Defines the plugin from a spec builder and routes each run's client to the tenant's definition.
 *
 * @param buildSpec - `(tokenUrl) => spec` for defineRestPlugin (function)
 * @returns Plugin definition; `restSpec` uses the default tenant (object)
 */
export function defineTenantAwarePlugin(buildSpec) {
  const definitionsByTenant = new Map([[DEFAULT_TENANT, defineRestPlugin(buildSpec(buildTokenUrl(DEFAULT_TENANT)))]]);
  const definitionFor = (tenant) => {
    if (!definitionsByTenant.has(tenant)) definitionsByTenant.set(tenant, defineRestPlugin(buildSpec(buildTokenUrl(tenant))));
    return definitionsByTenant.get(tenant);
  };
  const defaultDefinition = definitionsByTenant.get(DEFAULT_TENANT);
  return { ...defaultDefinition, createClient: (clientOptions) => definitionFor(readTenant(clientOptions.environment)).createClient(clientOptions) };
}
