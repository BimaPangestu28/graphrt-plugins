/**
 * Invoice arithmetic: line amounts, subtotal, discount, taxes (also negative
 * rates for withholding such as PPh 23), shipping, total and balance due.
 *
 * The plugin calculates these itself, in exact decimals, instead of trusting
 * numbers typed by a person or produced by a language model. Prices are tax
 * exclusive; every tax applies to the subtotal after the discount; shipping
 * is added after tax.
 */
import { invalidInput } from "./errors.mjs";
import { formatDecimal, multiplyDecimal, parseDecimal, percentOf, roundDecimal } from "./decimal.mjs";

export const MAX_ITEMS = 2000;
const MAX_TAXES = 10;

/**
 * Whether the values describe a document with line items to calculate.
 *
 * @param values - Document values (object)
 * @returns True when `items` is an array (boolean)
 */
export function hasLineItems(values) {
  return Array.isArray(values?.items);
}

/**
 * Adds calculated line amounts, totals and display flags to a document's values.
 *
 * @param values - Document values with `items`, and optional `discount`, `taxes`, `shipping`, `amount_paid` (object)
 * @param decimals - Decimals of the currency, 0-4 (number)
 * @returns A copy of the values with `items[].number`, `items[].amount`, `totals` and `flags` set (object)
 * @throws PluginError kind `invalid_input` - When a number is missing or malformed, or a given amount contradicts quantity x unit_price
 *
 * @example
 * calculateInvoice({ items: [{ description: "Design", quantity: 2, unit_price: "750000" }], taxes: [{ name: "PPN", rate: 11 }] }, 0).totals.total; // "1665000"
 */
export function calculateInvoice(values, decimals) {
  if (!hasLineItems(values)) throw invalidInput("`values.items` must be a list of line items");
  if (values.items.length > MAX_ITEMS) throw invalidInput(`\`values.items\` has ${values.items.length} entries, over the limit of ${MAX_ITEMS}`);
  const lines = values.items.map((item, index) => calculateLine(item, index, decimals));
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0n);
  const discount = calculateDiscount(values.discount, subtotal, decimals);
  const taxable = subtotal - discount;
  const taxes = readTaxes(values.taxes).map((tax) => ({ ...tax, amount: roundDecimal(percentOf(taxable, tax.rate), decimals) }));
  const taxTotal = taxes.reduce((sum, tax) => sum + tax.amount, 0n);
  const shipping = readOptionalAmount(values.shipping, "shipping", decimals);
  const amountPaid = readOptionalAmount(values.amount_paid, "amount_paid", decimals);
  const total = taxable + taxTotal + shipping;
  const text = (scaledValue) => formatDecimal(scaledValue, decimals);
  return {
    ...values,
    items: lines.map((line) => ({ ...line.item, number: line.number, amount: text(line.amount) })),
    totals: {
      subtotal: text(subtotal),
      discount: text(discount),
      taxable: text(taxable),
      taxes: taxes.map((tax) => ({ name: tax.name, rate: tax.rateText, amount: text(tax.amount) })),
      tax_total: text(taxTotal),
      shipping: text(shipping),
      total: text(total),
      amount_paid: text(amountPaid),
      balance_due: text(total - amountPaid),
    },
    flags: {
      has_period: values.items.some((item) => isPresent(item?.period)),
      has_quantity: values.items.some((item) => isPresent(item?.quantity) || isPresent(item?.unit_price)),
      has_discount: discount !== 0n,
      has_taxes: taxes.length > 0,
      show_tax_note: taxes.length === 0 && isPresent(values.tax_note),
      has_shipping: shipping !== 0n,
      has_amount_paid: amountPaid !== 0n,
    },
  };
}

function calculateLine(item, index, decimals) {
  const label = `items[${index}]`;
  if (typeof item !== "object" || item === null || Array.isArray(item)) throw invalidInput(`\`${label}\` must be an object with a description and an amount, or a quantity and unit_price`);
  const hasPricing = isPresent(item.quantity) || isPresent(item.unit_price);
  if (!hasPricing && !isPresent(item.amount)) throw invalidInput(`\`${label}\` needs \`amount\`, or \`quantity\` and \`unit_price\``);
  const computed = hasPricing ? priceLine(item, label, decimals) : null;
  const given = isPresent(item.amount) ? roundDecimal(parseDecimal(item.amount, `${label}.amount`), decimals) : null;
  if (computed !== null && given !== null && computed !== given) {
    throw invalidInput(`\`${label}.amount\` is ${formatDecimal(given, decimals)} but quantity x unit_price less its discount is ${formatDecimal(computed, decimals)}; correct one of them or leave \`amount\` out`);
  }
  return { item, number: index + 1, amount: computed ?? given };
}

function priceLine(item, label, decimals) {
  if (!isPresent(item.unit_price)) throw invalidInput(`\`${label}.unit_price\` is required when \`quantity\` is given`);
  const quantity = isPresent(item.quantity) ? parseDecimal(item.quantity, `${label}.quantity`) : parseDecimal("1", label);
  const gross = roundDecimal(multiplyDecimal(quantity, parseDecimal(item.unit_price, `${label}.unit_price`)), decimals);
  return gross - calculateDiscount(item.discount, gross, decimals, `${label}.discount`);
}

// A discount is an amount (number or `{amount}`) or a share of the base (`{percent}`).
function calculateDiscount(rawDiscount, base, decimals, label = "discount") {
  if (!isPresent(rawDiscount)) return 0n;
  const isObject = typeof rawDiscount === "object" && !Array.isArray(rawDiscount);
  if (isObject && isPresent(rawDiscount.percent) && isPresent(rawDiscount.amount)) throw invalidInput(`\`${label}\` takes \`percent\` or \`amount\`, not both`);
  if (isObject && isPresent(rawDiscount.percent)) return roundDecimal(percentOf(base, parseRate(rawDiscount.percent, `${label}.percent`)), decimals);
  if (isObject && !isPresent(rawDiscount.amount)) throw invalidInput(`\`${label}\` must be a number, or an object with \`percent\` or \`amount\``);
  const amount = roundDecimal(parseDecimal(isObject ? rawDiscount.amount : rawDiscount, isObject ? `${label}.amount` : label), decimals);
  if (amount < 0n) throw invalidInput(`\`${label}\` must not be negative`);
  return amount;
}

function readTaxes(rawTaxes) {
  if (!isPresent(rawTaxes)) return [];
  if (!Array.isArray(rawTaxes)) throw invalidInput("`taxes` must be a list such as [{\"name\": \"PPN\", \"rate\": 11}]");
  if (rawTaxes.length > MAX_TAXES) throw invalidInput(`\`taxes\` has ${rawTaxes.length} entries, over the limit of ${MAX_TAXES}`);
  // A tax line whose rate was left empty on purpose (a form field nobody filled in: `rate: ""`) is no tax at all.
  const givenTaxes = rawTaxes.filter((tax) => !(typeof tax === "object" && tax !== null && Object.hasOwn(tax, "rate") && !isPresent(tax.rate)));
  return givenTaxes.map((tax, index) => {
    if (typeof tax !== "object" || tax === null || !isPresent(tax.rate)) throw invalidInput(`\`taxes[${index}]\` needs \`name\` and \`rate\` (a percentage; negative for a withholding)`);
    return { name: String(tax.name ?? "Tax"), rate: parseRate(tax.rate, `taxes[${index}].rate`), rateText: trimRate(tax.rate) };
  });
}

function parseRate(rawRate, label) {
  const rate = parseDecimal(typeof rawRate === "string" ? rawRate.replace(/\s*%$/, "") : rawRate, label);
  if (rate > parseDecimal("100", label) || rate < parseDecimal("-100", label)) throw invalidInput(`\`${label}\` must be a percentage from -100 to 100`);
  return rate;
}

function trimRate(rawRate) {
  return String(rawRate).replace(/\s*%$/, "").trim();
}

function readOptionalAmount(rawValue, label, decimals) {
  return isPresent(rawValue) ? roundDecimal(parseDecimal(rawValue, label), decimals) : 0n;
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}
