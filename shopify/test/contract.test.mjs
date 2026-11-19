import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const URL = "https://acme.myshopify.com/admin/api/2026-10/graphql.json";
const queryOf = (operationName) => pluginDefinition.restSpec.operations.find((operation) => operation.name === operationName).constants.body.query;
const graphql = (operationName, variables) => ({ method: "POST", url: URL, query: "absent", json: { query: queryOf(operationName), variables } });
const KEY = "11111111-2222-3333-4444-555555555555";

describeRestPluginContract(pluginDefinition, {
  environment: { SHOPIFY_SHOP_DOMAIN: "acme.myshopify.com" },
  operations: {
    get_shop: {
      args: {},
      request: { method: "POST", url: URL, query: "absent", json: { query: queryOf("get_shop") } },
      response: { body: { data: { shop: { name: "Acme" } } } },
      expect: { data: { name: "Acme" } },
    },
    list_products: {
      args: { query: "status:active", limit: 10 },
      request: graphql("list_products", { query: "status:active", reverse: true, first: 10 }),
      response: { body: { data: { products: { nodes: [{ id: "gid://shopify/Product/1" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } },
      expect: { data: [{ id: "gid://shopify/Product/1" }] },
    },
    get_product: { args: { product_id: "gid://shopify/Product/1" }, request: graphql("get_product", { id: "gid://shopify/Product/1" }) },
    list_orders: { args: { query: "financial_status:paid", reverse: false }, request: graphql("list_orders", { query: "financial_status:paid", reverse: false, first: 50 }) },
    get_order: { args: { order_id: "gid://shopify/Order/1" }, request: graphql("get_order", { id: "gid://shopify/Order/1" }) },
    list_customers: { args: { query: "email:ana@example.com" }, request: graphql("list_customers", { query: "email:ana@example.com", reverse: true, first: 50 }) },
    get_customer: { args: { customer_id: "gid://shopify/Customer/1" }, request: graphql("get_customer", { id: "gid://shopify/Customer/1" }) },
    list_locations: { args: {}, request: graphql("list_locations", { first: 50 }) },
    list_inventory_levels: { args: { inventory_item_id: "gid://shopify/InventoryItem/1" }, request: graphql("list_inventory_levels", { id: "gid://shopify/InventoryItem/1", first: 50 }) },
    create_product: {
      args: { product_title: "Kopi", vendor: "Acme", tags: ["coffee"] },
      request: graphql("create_product", { product: { title: "Kopi", vendor: "Acme", tags: ["coffee"], status: "DRAFT" } }),
      response: { body: { data: { productCreate: { product: { id: "gid://shopify/Product/2" }, userErrors: [] } } } },
      expect: { data: { product: { id: "gid://shopify/Product/2" }, userErrors: [] } },
    },
    update_product: {
      args: { product_id: "gid://shopify/Product/2", status: "ACTIVE" },
      request: graphql("update_product", { product: { id: "gid://shopify/Product/2", status: "ACTIVE" } }),
    },
    adjust_inventory: {
      args: { reason: "correction", changes: [{ delta: -1, inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", changeFromQuantity: 5 }], idempotency_key: KEY },
      request: graphql("adjust_inventory", {
        input: { reason: "correction", name: "available", changes: [{ delta: -1, inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", changeFromQuantity: 5 }] },
        idempotencyKey: KEY,
      }),
    },
    update_order: { args: { order_id: "gid://shopify/Order/1", note: "VIP" }, request: graphql("update_order", { input: { id: "gid://shopify/Order/1", note: "VIP" } }) },
    create_refund: {
      args: { order_id: "gid://shopify/Order/1", refund_line_items: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 1 }], idempotency_key: KEY },
      request: graphql("create_refund", { input: { orderId: "gid://shopify/Order/1", refundLineItems: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 1 }] }, idempotencyKey: KEY }),
    },
    cancel_order: {
      args: { order_id: "gid://shopify/Order/1", reason: "CUSTOMER", restock: true, refund_to_original_payment: true },
      request: graphql("cancel_order", { orderId: "gid://shopify/Order/1", reason: "CUSTOMER", restock: true, refundMethod: { originalPaymentMethodsRefund: true } }),
    },
  },
});
