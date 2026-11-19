/**
 * woocommerce plugin definition: products and variations, orders, customers and refunds through the WooCommerce
 * REST API v3 (https://woocommerce.github.io/woocommerce-rest-api-docs/) of one store, WOOCOMMERCE_SITE_URL
 * (https only). Built with the declarative REST layer (docs/declarative-plugins.md) plus wrappers:
 *   - lib/tool-argument-policy.mjs: agents may not change prices or stock, nor cancel/refund/fail orders;
 *   - lib/tool-path-policy.mjs: api_request for tools only reaches an allowlist of read paths (payment gateway,
 *     settings, system status and webhook endpoints carry secrets).
 *
 * Auth: the REST API consumer key and secret as Basic auth, only over https (the plugin never sends them in the
 * query string).
 *
 * Agent policy: reads are tools; product updates (no price/stock) need WOOCOMMERCE_TOOL_ALLOW_PRODUCTS=1; order
 * status changes (on-hold only) need WOOCOMMERCE_TOOL_ALLOW_ORDER_STATUS=1; refunds are node only. api_request for
 * tools takes no query string in the path and only allowlisted query keys (lib/tool-query-policy.mjs: WordPress
 * `_method` / `rest_route` would turn a GET into a write).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { limitToolEnum, refuseToolArguments } from "./lib/tool-argument-policy.mjs";
import { guardToolApiRequest } from "./lib/tool-path-policy.mjs";
import { limitToolApiQuery } from "./lib/tool-query-policy.mjs";

const PRODUCT_POLICY = "optIn:WOOCOMMERCE_TOOL_ALLOW_PRODUCTS";
const ORDER_STATUS_POLICY = "optIn:WOOCOMMERCE_TOOL_ALLOW_ORDER_STATUS";
const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "draft"];
// processing/completed on an unpaid order would release goods without payment; pending re-opens payment. Agents
// may only put an order on hold.
const TOOL_ORDER_STATUSES = ["on-hold"];
const PRICE_AND_STOCK_ARGUMENTS = ["regular_price", "sale_price", "manage_stock", "stock_quantity", "stock_status"];
const ID = "[^/]+";
const TOOL_API_PATHS = [
  `/products(/${ID}(/variations(/${ID})?)?)?`,
  `/products/(categories|tags|attributes)(/${ID})?`,
  `/products/reviews(/${ID})?`,
  `/orders(/${ID}(/(notes|refunds)(/${ID})?)?)?`,
  `/customers(/${ID})?`,
  `/coupons(/${ID})?`,
  `/reports(/[^/]+)?`,
].map((pattern) => new RegExp(`^${pattern}$`));

/**
 * Builds the API base URL from WOOCOMMERCE_SITE_URL.
 *
 * @param environment - Environment variables (object)
 * @returns `<site>/wp-json/wc/v3` (string)
 * @throws Error - The site URL is missing, not https, or has credentials, a query or a fragment
 */
export function resolveWooCommerceBaseUrl(environment) {
  const siteText = String(environment.WOOCOMMERCE_SITE_URL ?? "").trim();
  let siteUrl;
  try {
    siteUrl = new URL(siteText);
  } catch {
    throw new Error("WOOCOMMERCE_SITE_URL must be your store's https URL, e.g. https://shop.example.com");
  }
  if (siteUrl.protocol !== "https:") throw new Error("WOOCOMMERCE_SITE_URL must use https (the consumer secret is sent with every request)");
  if (siteUrl.username || siteUrl.password || siteUrl.search || siteUrl.hash) throw new Error("WOOCOMMERCE_SITE_URL must not contain credentials, a query or a fragment");
  return `${siteUrl.origin}${siteUrl.pathname.replace(/\/+$/, "")}/wp-json/wc/v3`;
}

const pages = { pagePagination: { pageParam: "page", sizeParam: "per_page" }, defaultLimit: 20, maxLimit: 100 };
const idParam = (description) => ({ in: "path", type: "integer", required: true, min: 1, description });
const sortParams = {
  orderby: { in: "query", type: "string", enum: ["date", "id", "title", "slug", "modified", "include"] },
  order: { in: "query", type: "string", enum: ["asc", "desc"] },
};

const productOperations = [
  {
    name: "list_products",
    title: "List products",
    description: "List products (newest first by default)",
    path: "/products",
    params: {
      search: { in: "query", type: "string" },
      sku: { in: "query", type: "string" },
      status: { in: "query", type: "string", enum: ["any", "draft", "pending", "private", "publish"] },
      category: { in: "query", type: "string", description: "Category id" },
      stock_status: { in: "query", type: "string", enum: ["instock", "outofstock", "onbackorder"] },
      ...sortParams,
    },
    response: pages,
  },
  { name: "get_product", title: "Get product", description: "Retrieve a product", path: "/products/{product_id}", params: { product_id: idParam("Product id") } },
  {
    name: "list_product_variations",
    title: "List product variations",
    description: "List the variations of a variable product",
    path: "/products/{product_id}/variations",
    params: { product_id: idParam("Product id") },
    response: pages,
  },
  {
    name: "update_product",
    title: "Update product",
    description: "Update a product's name, descriptions, status, SKU, categories or tags; prices and stock too, but only from workflow nodes",
    method: "PUT",
    path: "/products/{product_id}",
    // Sending the same fields again leaves the product the same.
    write: "idempotent",
    toolPolicy: PRODUCT_POLICY,
    params: {
      product_id: idParam("Product id"),
      name: { in: "body", type: "string", minLength: 1 },
      description: { in: "body", type: "string" },
      short_description: { in: "body", type: "string" },
      status: { in: "body", type: "string", enum: ["draft", "pending", "private", "publish"] },
      sku: { in: "body", type: "string" },
      categories: { in: "body", type: "array", items: { type: "object" }, description: "[{id}]" },
      tags: { in: "body", type: "array", items: { type: "object" }, description: "[{id}] or [{name}]" },
      regular_price: { in: "body", type: "string", description: "Node only. Decimal string, e.g. \"19.99\"" },
      sale_price: { in: "body", type: "string", description: "Node only" },
      manage_stock: { in: "body", type: "boolean", description: "Node only" },
      stock_quantity: { in: "body", type: "integer", description: "Node only" },
      stock_status: { in: "body", type: "string", enum: ["instock", "outofstock", "onbackorder"], description: "Node only" },
    },
  },
];

const orderOperations = [
  {
    name: "list_orders",
    title: "List orders",
    description: "List orders (newest first by default)",
    path: "/orders",
    params: {
      status: { in: "query", type: "array", items: { type: "string", enum: ["any", ...ORDER_STATUSES] }, description: "Order statuses (comma-separated)" },
      customer: { in: "query", type: "integer", description: "Customer id" },
      search: { in: "query", type: "string" },
      after: { in: "query", type: "string", description: "Created after (ISO 8601)" },
      before: { in: "query", type: "string", description: "Created before (ISO 8601)" },
      ...sortParams,
    },
    response: pages,
  },
  { name: "get_order", title: "Get order", description: "Retrieve an order", path: "/orders/{order_id}", params: { order_id: idParam("Order id") } },
  {
    name: "update_order_status",
    title: "Update order status",
    description: "Change an order's status (WooCommerce may email the customer, e.g. on completed). Agent tools may only set on-hold",
    method: "PUT",
    path: "/orders/{order_id}",
    write: "idempotent",
    toolPolicy: ORDER_STATUS_POLICY,
    params: { order_id: idParam("Order id"), status: { in: "body", type: "string", required: true, enum: ORDER_STATUSES } },
  },
  { name: "list_order_refunds", title: "List order refunds", description: "List the refunds of an order", path: "/orders/{order_id}/refunds", params: { order_id: idParam("Order id") }, response: pages },
  {
    name: "create_refund",
    title: "Create refund",
    description: "Refund an order (by default through the payment gateway: money goes back to the customer)",
    method: "POST",
    path: "/orders/{order_id}/refunds",
    write: "unsafe",
    nodeOnly: true,
    checkHint: "list_order_refunds for the order",
    params: {
      order_id: idParam("Order id"),
      amount: { in: "body", type: "string", required: true, minLength: 1, description: "Decimal string, e.g. \"10.00\"" },
      reason: { in: "body", type: "string" },
      line_items: { in: "body", type: "array", items: { type: "object" }, description: "[{id, quantity, refund_total, refund_tax?}]" },
      api_refund: { in: "body", type: "boolean", default: true, description: "Refund through the payment gateway (false only records it)" },
      api_restock: { in: "body", type: "boolean", description: "Restock refunded items" },
    },
  },
];

const customerOperations = [
  {
    name: "list_customers",
    title: "List customers",
    description: "List customers",
    path: "/customers",
    params: { search: { in: "query", type: "string" }, email: { in: "query", type: "string" }, role: { in: "query", type: "string", default: "all" }, ...sortParams },
    response: pages,
  },
  { name: "get_customer", title: "Get customer", description: "Retrieve a customer", path: "/customers/{customer_id}", params: { customer_id: idParam("Customer id") } },
];

const restDefinition = defineRestPlugin({
  name: "woocommerce",
  version: "0.1.0",
  description: "WooCommerce REST API v3: products, variations, orders, customers, refunds; product and order-status writes opt-in, prices, stock and refunds node only",
  apiName: "WooCommerce REST API",
  baseUrl: resolveWooCommerceBaseUrl,
  extraEnv: ["WOOCOMMERCE_SITE_URL", "WOOCOMMERCE_TOOL_API_EXTRA_PATHS"],
  auth: { type: "basic", userEnv: "WOOCOMMERCE_CONSUMER_KEY", passwordEnv: "WOOCOMMERCE_CONSUMER_SECRET" },
  // Errors are {"code": "woocommerce_rest_cannot_view", "message": "...", "data": {"status": 401}}.
  errors: {
    messagePath: "message",
    codePath: "code",
    kindByCode: {
      woocommerce_rest_authentication_error: "auth_error",
      woocommerce_rest_cannot_view: "permission_denied",
      woocommerce_rest_cannot_edit: "permission_denied",
      woocommerce_rest_cannot_create: "permission_denied",
      woocommerce_rest_product_invalid_id: "not_found",
      woocommerce_rest_shop_order_invalid_id: "not_found",
      woocommerce_rest_invalid_id: "not_found",
      rest_no_route: "not_found",
      rest_invalid_param: "invalid_input",
      rest_missing_callback_param: "invalid_input",
    },
  },
  apiRequest: { examplePath: "/reports/sales" },
  operations: [...productOperations, ...orderOperations, ...customerOperations],
});

const noPriceOrStock = refuseToolArguments(restDefinition, {
  operationNames: ["update_product"],
  argumentNames: PRICE_AND_STOCK_ARGUMENTS,
  reason: "price and stock changes are node only",
});
const limitedStatuses = limitToolEnum(noPriceOrStock, {
  operationNames: ["update_order_status"],
  argumentName: "status",
  allowedValues: TOOL_ORDER_STATUSES,
  reason: "processing and completed (which release goods, also for unpaid orders), cancelling, refunding and failing orders are node only",
});

const queryLimitedDefinition = limitToolApiQuery(limitedStatuses);

export const pluginDefinition = guardToolApiRequest(queryLimitedDefinition, {
  allowedPaths: TOOL_API_PATHS,
  extraAllowedPathsEnv: "WOOCOMMERCE_TOOL_API_EXTRA_PATHS",
  reason: "agent tools may only read products, orders, customers, coupons and reports (settings, payment gateways, system status and webhooks carry secrets); use a workflow node",
});
