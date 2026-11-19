/**
 * shopify plugin definition: shop, products, orders, customers, locations and inventory levels through the Shopify
 * Admin GraphQL API (https://shopify.dev/docs/api/admin-graphql), version 2026-10. Every operation is a POST to
 * /admin/api/2026-10/graphql.json with a constant GraphQL document and typed variables; callers never send
 * free-form GraphQL, and there is no api_request. Built with the declarative REST layer plus
 * lib/graphql-mutations.mjs (userErrors become errors; @idempotent keys for inventory and refunds).
 *
 * Agent policy: reads are tools; creating and updating products needs SHOPIFY_TOOL_ALLOW_PRODUCTS=1; inventory
 * adjustments, order updates, refunds and cancellations are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { addIdempotencyKeys, checkInventoryChanges, checkUserErrors } from "./lib/graphql-mutations.mjs";

export const SHOPIFY_API_VERSION = "2026-10";
const GRAPHQL_PATH = `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
const PRODUCT_POLICY = "optIn:SHOPIFY_TOOL_ALLOW_PRODUCTS";
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const MONEY = "shopMoney { amount currencyCode }";
const PRODUCT_FIELDS = `id title handle status vendor productType tags totalInventory createdAt updatedAt
  variants(first: 20) { nodes { id title sku price inventoryQuantity inventoryItem { id } } }`;
const ORDER_FIELDS = `id name email createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus note tags
  totalPriceSet { ${MONEY} } currentTotalPriceSet { ${MONEY} } totalRefundedSet { ${MONEY} }
  customer { id displayName } lineItems(first: 50) { nodes { id title sku quantity currentQuantity originalUnitPriceSet { ${MONEY} } } }`;
const CUSTOMER_FIELDS = `id displayName firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }
  numberOfOrders amountSpent { amount currencyCode } tags createdAt updatedAt`;

/**
 * Builds the shop's Admin API origin from SHOPIFY_SHOP_DOMAIN.
 *
 * @param environment - Environment variables (object)
 * @returns `https://<shop>.myshopify.com` (string)
 * @throws Error - The domain is missing or not `<name>.myshopify.com`
 */
export function resolveShopOrigin(environment) {
  const shopDomain = String(environment.SHOPIFY_SHOP_DOMAIN ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
  if (!SHOP_DOMAIN_PATTERN.test(shopDomain)) throw new Error("SHOPIFY_SHOP_DOMAIN must be your store's <name>.myshopify.com domain");
  return `https://${shopDomain}`;
}

function connectionPages(connectionPath) {
  return {
    dataPath: `data.${connectionPath}.nodes`,
    cursorPath: `data.${connectionPath}.pageInfo.endCursor`,
    hasMorePath: `data.${connectionPath}.pageInfo.hasNextPage`,
    cursorParam: "variables.after",
    limitParam: "variables.first",
    defaultLimit: 50,
    maxLimit: 250,
  };
}

const graphqlQuery = ({ query, ...operation }) => ({ method: "POST", path: GRAPHQL_PATH, write: "idempotent", constants: { body: { query } }, ...operation });
const graphqlMutation = ({ query, ...operation }) => ({ method: "POST", path: GRAPHQL_PATH, write: "unsafe", constants: { body: { query } }, ...operation });
const variable = (name, spec) => ({ in: "body", wireName: `variables.${name}`, ...spec });
const gid = (name, resource) => variable(name, { type: "string", required: true, minLength: 1, description: `Global id, e.g. gid://shopify/${resource}/123` });
const searchQuery = variable("query", { type: "string", description: "Shopify search syntax, e.g. status:active vendor:Acme" });
const reverse = variable("reverse", { type: "boolean", default: true, description: "Newest first" });
const idempotencyKey = variable("idempotencyKey", { type: "string", description: "Retry key (default: a fresh UUID); pass the same key to retry safely" });

const readOperations = [
  graphqlQuery({
    name: "get_shop",
    title: "Get shop",
    description: "The store's name, domains and currency; a cheap way to check the token",
    query: "query Shop { shop { id name myshopifyDomain primaryDomain { url } currencyCode ianaTimezone } }",
    response: { dataPath: "data.shop" },
  }),
  graphqlQuery({
    name: "list_products",
    title: "List products",
    description: "List products with their first 20 variants, newest first",
    query: `query Products($first: Int!, $after: String, $query: String, $reverse: Boolean) {
  products(first: $first, after: $after, query: $query, reverse: $reverse, sortKey: CREATED_AT) { nodes { ${PRODUCT_FIELDS} } ${PAGE_INFO} } }`,
    params: { query: searchQuery, reverse },
    response: connectionPages("products"),
  }),
  graphqlQuery({
    name: "get_product",
    title: "Get product",
    description: "Retrieve a product with its description and first 20 variants",
    query: `query Product($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} descriptionHtml onlineStoreUrl } }`,
    params: { product_id: gid("id", "Product") },
    response: { dataPath: "data.product" },
  }),
  graphqlQuery({
    name: "list_orders",
    title: "List orders",
    description: "List orders, newest first (orders older than 60 days need the read_all_orders scope)",
    query: `query Orders($first: Int!, $after: String, $query: String, $reverse: Boolean) {
  orders(first: $first, after: $after, query: $query, reverse: $reverse, sortKey: CREATED_AT) { nodes { ${ORDER_FIELDS} } ${PAGE_INFO} } }`,
    params: { query: variable("query", { type: "string", description: "e.g. financial_status:paid fulfillment_status:unfulfilled created_at:>2026-11-01" }), reverse },
    response: connectionPages("orders"),
  }),
  graphqlQuery({
    name: "get_order",
    title: "Get order",
    description: "Retrieve an order with its line items",
    query: `query Order($id: ID!) { order(id: $id) { ${ORDER_FIELDS} shippingAddress { name address1 city province country zip } } }`,
    params: { order_id: gid("id", "Order") },
    response: { dataPath: "data.order" },
  }),
  graphqlQuery({
    name: "list_customers",
    title: "List customers",
    description: "List customers, newest first",
    query: `query Customers($first: Int!, $after: String, $query: String, $reverse: Boolean) {
  customers(first: $first, after: $after, query: $query, reverse: $reverse, sortKey: CREATED_AT) { nodes { ${CUSTOMER_FIELDS} } ${PAGE_INFO} } }`,
    params: { query: variable("query", { type: "string", description: "e.g. email:ana@example.com or country:Indonesia" }), reverse },
    response: connectionPages("customers"),
  }),
  graphqlQuery({
    name: "get_customer",
    title: "Get customer",
    description: "Retrieve a customer",
    query: `query Customer($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} note } }`,
    params: { customer_id: gid("id", "Customer") },
    response: { dataPath: "data.customer" },
  }),
  graphqlQuery({
    name: "list_locations",
    title: "List locations",
    description: "List the store's locations (for inventory)",
    query: `query Locations($first: Int!, $after: String) { locations(first: $first, after: $after) { nodes { id name isActive address { city country } } ${PAGE_INFO} } }`,
    response: connectionPages("locations"),
  }),
  graphqlQuery({
    name: "list_inventory_levels",
    title: "List inventory levels",
    description: "Quantities (available, committed, incoming, on_hand, reserved) of one inventory item per location",
    query: `query InventoryLevels($id: ID!, $first: Int!, $after: String) {
  inventoryItem(id: $id) { inventoryLevels(first: $first, after: $after) { nodes { id location { id name }
    quantities(names: ["available", "committed", "incoming", "on_hand", "reserved"]) { name quantity } } ${PAGE_INFO} } } }`,
    params: { inventory_item_id: gid("id", "InventoryItem") },
    response: connectionPages("inventoryItem.inventoryLevels"),
  }),
];

const productInputFields = {
  description_html: variable("product.descriptionHtml", { type: "string" }),
  vendor: variable("product.vendor", { type: "string" }),
  product_type: variable("product.productType", { type: "string" }),
  tags: variable("product.tags", { type: "array", items: { type: "string" } }),
  status: variable("product.status", { type: "string", enum: ["ACTIVE", "ARCHIVED", "DRAFT"], description: "ACTIVE publishes it to the sales channels it is on" }),
};

const writeOperations = [
  graphqlMutation({
    name: "create_product",
    title: "Create product",
    description: "Create a product (DRAFT by default); variants and prices are set in the admin or a node",
    toolPolicy: PRODUCT_POLICY,
    checkHint: "list_products with query title:<title>",
    query: `mutation ProductCreate($product: ProductCreateInput!) { productCreate(product: $product) { product { ${PRODUCT_FIELDS} } userErrors { field message } } }`,
    params: { product_title: variable("product.title", { type: "string", required: true, minLength: 1 }), ...productInputFields, status: { ...productInputFields.status, default: "DRAFT" } },
    response: { dataPath: "data.productCreate" },
  }),
  graphqlMutation({
    name: "update_product",
    title: "Update product",
    description: "Update a product's title, description, vendor, type, tags or status",
    toolPolicy: PRODUCT_POLICY,
    checkHint: "get_product",
    query: `mutation ProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { ${PRODUCT_FIELDS} } userErrors { field message } } }`,
    params: { product_id: gid("product.id", "Product"), product_title: variable("product.title", { type: "string", minLength: 1 }), ...productInputFields },
    response: { dataPath: "data.productUpdate" },
  }),
  graphqlMutation({
    name: "adjust_inventory",
    title: "Adjust inventory",
    description: "Change inventory quantities by a delta per item and location",
    nodeOnly: true,
    checkHint: "list_inventory_levels for the item; retry with the same idempotency_key",
    query: `mutation InventoryAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { inventoryAdjustmentGroup { createdAt reason changes { name delta } } userErrors { field message } } }`,
    params: {
      reason: variable("input.reason", { type: "string", required: true, description: "e.g. correction, received, damaged, cycle_count_available" }),
      quantity_name: variable("input.name", { type: "string", enum: ["available", "damaged", "quality_control", "reserved", "safety_stock", "on_hand"], default: "available", description: "Quantity state (sent as `name`)" }),
      reference_document_uri: variable("input.referenceDocumentUri", { type: "string" }),
      changes: variable("input.changes", { type: "array", required: true, items: { type: "object" }, description: "[{delta, inventoryItemId, locationId, changeFromQuantity (required, null to skip the check), ledgerDocumentUri (required unless quantity_name is available)}]" }),
      idempotency_key: idempotencyKey,
    },
    response: { dataPath: "data.inventoryAdjustQuantities" },
  }),
  graphqlMutation({
    name: "update_order",
    title: "Update order",
    description: "Edit an order's note, tags or email",
    nodeOnly: true,
    checkHint: "get_order",
    query: `mutation OrderUpdate($input: OrderInput!) { orderUpdate(input: $input) { order { id name note tags email } userErrors { field message } } }`,
    params: {
      order_id: gid("input.id", "Order"),
      note: variable("input.note", { type: "string" }),
      tags: variable("input.tags", { type: "array", items: { type: "string" } }),
      email: variable("input.email", { type: "string" }),
    },
    response: { dataPath: "data.orderUpdate" },
  }),
  graphqlMutation({
    name: "create_refund",
    title: "Create refund",
    description: "Refund line items, shipping or an amount of an order: money goes back to the customer",
    nodeOnly: true,
    checkHint: "get_order and look at totalRefundedSet; retry with the same idempotency_key",
    query: `mutation RefundCreate($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) { refund { id totalRefundedSet { ${MONEY} } } userErrors { field message } } }`,
    params: {
      order_id: gid("input.orderId", "Order"),
      note: variable("input.note", { type: "string" }),
      notify: variable("input.notify", { type: "boolean", description: "Email the customer" }),
      refund_line_items: variable("input.refundLineItems", { type: "array", items: { type: "object" }, description: "[{lineItemId, quantity, restockType?, locationId?}]" }),
      shipping: variable("input.shipping", { type: "object", description: "{amount} or {fullRefund: true}" }),
      transactions: variable("input.transactions", { type: "array", items: { type: "object" }, description: "[{orderId, parentId, kind: REFUND, gateway, amount}]" }),
      idempotency_key: idempotencyKey,
    },
    response: { dataPath: "data.refundCreate" },
  }),
  graphqlMutation({
    name: "cancel_order",
    title: "Cancel order",
    description: "Cancel an order (asynchronous job), optionally refunding to the original payment methods and restocking",
    nodeOnly: true,
    checkHint: "get_order and look at cancelledAt",
    query: `mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $refundMethod: OrderCancelRefundMethodInput, $notifyCustomer: Boolean, $staffNote: String) {
  orderCancel(orderId: $orderId, reason: $reason, restock: $restock, refundMethod: $refundMethod, notifyCustomer: $notifyCustomer, staffNote: $staffNote) { job { id done } orderCancelUserErrors { field message code } } }`,
    params: {
      order_id: gid("orderId", "Order"),
      reason: variable("reason", { type: "string", required: true, enum: ["CUSTOMER", "DECLINED", "FRAUD", "INVENTORY", "STAFF", "OTHER"] }),
      restock: variable("restock", { type: "boolean", required: true }),
      refund_to_original_payment: variable("refundMethod.originalPaymentMethodsRefund", { type: "boolean", description: "Refund to the original payment methods" }),
      notify_customer: variable("notifyCustomer", { type: "boolean" }),
      staff_note: variable("staffNote", { type: "string" }),
    },
    response: { dataPath: "data.orderCancel" },
  }),
];

const restDefinition = defineRestPlugin({
  name: "shopify",
  version: "0.1.0",
  description: "Shopify Admin GraphQL API: shop, products, orders, customers, locations, inventory levels; product writes opt-in, inventory, refunds and cancellations node only",
  apiName: "Shopify Admin GraphQL API",
  baseUrl: resolveShopOrigin,
  allowedHostSuffix: ".myshopify.com",
  extraEnv: ["SHOPIFY_SHOP_DOMAIN"],
  auth: { type: "header", header: "X-Shopify-Access-Token", env: "SHOPIFY_ACCESS_TOKEN" },
  // GraphQL errors: {"errors": [{"message": "...", "extensions": {"code": "THROTTLED"}}]} with HTTP 200; a bad token
  // gives 401 {"errors": "[API] Invalid API key or access token (unrecognized login or wrong password)"}.
  errors: {
    messagePath: ["errors.0.message", "errors"],
    codePath: "errors.0.extensions.code",
    kindByCode: { THROTTLED: "rate_limited", ACCESS_DENIED: "permission_denied", INTERNAL_SERVER_ERROR: "api_error" },
    errorPath: "errors",
  },
  apiRequest: false,
  operations: [...readOperations, ...writeOperations],
});

const userErrorCheckedDefinition = checkUserErrors(checkInventoryChanges(restDefinition), ["create_product", "update_product", "adjust_inventory", "update_order", "create_refund", "cancel_order"]);

// Outermost, so every error of a keyed mutation names the key to retry with.
export const pluginDefinition = addIdempotencyKeys(userErrorCheckedDefinition, ["adjust_inventory", "create_refund"]);
