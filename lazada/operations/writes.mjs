/**
 * Write operations: price and stock updates and order fulfilment (pack, ready to ship). They are POST writes that
 * the shared client never retries after an unknown outcome, and they are node only (never agent tools): the same
 * ruling as the Shopee plugin, a person decides in a workflow when prices, stock and shipments change.
 */
import { extractLazadaData } from "../lib/client.mjs";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { buildSkuPayload, MAX_SKUS_PER_UPDATE } from "../lib/xml-payload.mjs";

const UNKNOWN_OUTCOME_HINT = "After a network error or timeout the change may still have been applied: check before retrying.";
const SKU_ID_FIELDS = [["item_id", "ItemId"], ["sku_id", "SkuId"], ["seller_sku", "SellerSku"]];
const PRICE_QUANTITY_FIELDS = [...SKU_ID_FIELDS, ["price", "Price"], ["sale_price", "SalePrice"], ["sale_start_date", "SaleStartDate"], ["sale_end_date", "SaleEndDate"], ["quantity", "Quantity"]];
const SELLABLE_FIELDS = [...SKU_ID_FIELDS, ["sellable_quantity", "SellableQuantity"]];
const skusProperty = (description) => ({ type: "array", items: { type: "object" }, minItems: 1, maxItems: MAX_SKUS_PER_UPDATE, description });

function requireObject(argumentName, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PluginError(`\`${argumentName}\` must be an object`, { kind: "invalid_input" });
  return value;
}

const postData = (path, buildForm) => async ({ client, args, signal }) => ({ data: extractLazadaData(await client.request({ method: "POST", path, form: buildForm(args), signal })) ?? null });

export const writeOperations = [
  {
    name: "update_price_quantity",
    nodeOnly: true,
    title: "Update Lazada price and stock",
    description: `Set price, sale price (with dates) and/or quantity of up to 50 SKUs. ${UNKNOWN_OUTCOME_HINT} Check with get_product.`,
    parameters: {
      type: "object",
      properties: {
        skus: skusProperty("[{item_id, sku_id} or {seller_sku}, plus price?, sale_price?, sale_start_date?, sale_end_date?, quantity?}]"),
      },
      required: ["skus"],
    },
    run: postData("/product/price_quantity/update", (args) => ({ payload: buildSkuPayload(args.skus, PRICE_QUANTITY_FIELDS, ["price", "sale_price", "quantity"]) })),
  },
  {
    name: "update_sellable_stock",
    nodeOnly: true,
    title: "Update Lazada sellable stock",
    description: `Set the sellable quantity of up to 50 SKUs (multi-warehouse aware). ${UNKNOWN_OUTCOME_HINT} Check with get_product.`,
    parameters: { type: "object", properties: { skus: skusProperty("[{item_id, sku_id} or {seller_sku}, sellable_quantity}]") }, required: ["skus"] },
    run: postData("/product/stock/sellable/update", (args) => ({ payload: buildSkuPayload(args.skus, SELLABLE_FIELDS, ["sellable_quantity"]) })),
  },
  {
    name: "pack_order",
    nodeOnly: true,
    title: "Pack Lazada order",
    description: `Pack order items for shipping (/order/fulfill/pack): returns the package ids. ${UNKNOWN_OUTCOME_HINT} Check with get_order_items.`,
    parameters: {
      type: "object",
      properties: {
        pack_request: { type: "object", description: "The packReq object of Lazada's /order/fulfill/pack docs, e.g. {pack_order_list: [{order_id, order_item_list: [...]}], delivery_type: \"dropship\", shipping_allocate_type: \"TFS\"}" },
      },
      required: ["pack_request"],
    },
    run: postData("/order/fulfill/pack", (args) => ({ packReq: requireObject("pack_request", args.pack_request) })),
  },
  {
    name: "ready_to_ship",
    nodeOnly: true,
    title: "Mark Lazada packages ready to ship",
    description: `Set packed packages ready to ship (/order/package/rts), which books the pickup. ${UNKNOWN_OUTCOME_HINT} Check with get_order_items.`,
    parameters: {
      type: "object",
      properties: { ready_to_ship_request: { type: "object", description: "The readyToShipReq object of Lazada's /order/package/rts docs, e.g. {packages: [{package_id: \"FP...\"}]}" } },
      required: ["ready_to_ship_request"],
    },
    run: postData("/order/package/rts", (args) => ({ readyToShipReq: requireObject("ready_to_ship_request", args.ready_to_ship_request) })),
  },
];
