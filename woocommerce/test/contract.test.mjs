import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://shop.example.com/wp-json/wc/v3";

describeRestPluginContract(pluginDefinition, {
  environment: { WOOCOMMERCE_SITE_URL: "https://shop.example.com", WOOCOMMERCE_CONSUMER_KEY: "ck_fake", WOOCOMMERCE_TOOL_API_EXTRA_PATHS: "/anything" },
  operations: {
    list_products: {
      args: { search: "kopi", stock_status: "instock", limit: 2 },
      request: { method: "GET", url: `${API}/products`, query: { search: "kopi", stock_status: "instock", per_page: "2" } },
      response: { body: [{ id: 1 }, { id: 2 }] },
      expect: { data: [{ id: 1 }, { id: 2 }] },
    },
    get_product: { args: { product_id: 7 }, request: { method: "GET", url: `${API}/products/7`, query: "absent" } },
    list_product_variations: { args: { product_id: 7 }, request: { method: "GET", url: `${API}/products/7/variations`, query: { per_page: "20" } } },
    update_product: {
      args: { product_id: 7, name: "Kopi Gayo", status: "publish" },
      request: { method: "PUT", url: `${API}/products/7`, query: "absent", json: { name: "Kopi Gayo", status: "publish" } },
    },
    list_orders: {
      args: { status: ["processing", "on-hold"], after: "2026-11-01T00:00:00" },
      request: { method: "GET", url: `${API}/orders`, query: { status: "processing,on-hold", after: "2026-11-01T00:00:00", per_page: "20" } },
    },
    get_order: { args: { order_id: 42 }, request: { method: "GET", url: `${API}/orders/42`, query: "absent" } },
    update_order_status: { args: { order_id: 42, status: "on-hold" }, request: { method: "PUT", url: `${API}/orders/42`, query: "absent", json: { status: "on-hold" } } },
    list_order_refunds: { args: { order_id: 42 }, request: { method: "GET", url: `${API}/orders/42/refunds`, query: { per_page: "20" } } },
    create_refund: {
      args: { order_id: 42, amount: "10.00", reason: "Damaged" },
      request: { method: "POST", url: `${API}/orders/42/refunds`, query: "absent", json: { amount: "10.00", reason: "Damaged", api_refund: true } },
    },
    list_customers: { args: { email: "ana@example.com" }, request: { method: "GET", url: `${API}/customers`, query: { email: "ana@example.com", role: "all", per_page: "20" } } },
    get_customer: { args: { customer_id: 3 }, request: { method: "GET", url: `${API}/customers/3`, query: "absent" } },
  },
});
