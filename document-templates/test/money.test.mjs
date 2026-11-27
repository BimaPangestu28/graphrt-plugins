/**
 * Exact decimals, invoice totals and locale formatting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDecimal, multiplyDecimal, parseDecimal, percentOf, roundDecimal } from "../lib/decimal.mjs";
import { formatDate, formatMoney, formatNumber, parseIsoDate, readFormatSettings } from "../lib/formatting.mjs";
import { MAX_ITEMS, calculateInvoice } from "../lib/invoice-totals.mjs";

const decimal = (text) => parseDecimal(text, "x");

test("decimals: sums and products are exact where binary floats are not", () => {
  assert.equal(formatDecimal(decimal("0.1") + decimal("0.2"), 2), "0.30");
  assert.equal(formatDecimal(multiplyDecimal(decimal("1.15"), decimal("3")), 2), "3.45");
  assert.equal(formatDecimal(percentOf(decimal("1500000"), decimal("11")), 0), "165000");
  assert.equal(formatDecimal(decimal(1e-7), 7), "0.0000001");
});

test("decimals: rounding is half away from zero, at the requested digits", () => {
  const cases = [["2.345", 2, "2.35"], ["2.344", 2, "2.34"], ["-2.345", 2, "-2.35"], ["0.5", 0, "1"], ["-0.5", 0, "-1"], ["1234.5", 0, "1235"], ["-0.004", 2, "0.00"]];
  for (const [input, digits, expected] of cases) assert.equal(formatDecimal(roundDecimal(decimal(input), digits), digits), expected, input);
});

test("decimals: anything but a plain number is refused with the field's name", () => {
  for (const badValue of ["1.500.000", "1,500", "Rp 1000", "", "abc", "1e5", 1e21, null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY, "9".repeat(30)]) {
    assert.throws(() => parseDecimal(badValue, "items[0].unit_price"), (error) => error.kind === "invalid_input" && error.message.includes("items[0].unit_price"), String(badValue));
  }
});

test("invoice: quantity x unit price, line and document discounts, PPN and a PPh withholding, shipping, payment", () => {
  const invoice = calculateInvoice({
    items: [
      { description: "A", quantity: 2, unit_price: 1500000 },
      { description: "B", quantity: "3.5", unit_price: "2000000", discount: { percent: 10 } },
      { description: "C", amount: "250000.4" },
    ],
    discount: { percent: 5 },
    taxes: [{ name: "PPN", rate: 11 }, { name: "PPh 23", rate: "-2%" }],
    shipping: 150000,
    amount_paid: "1000000",
  }, 0);
  assert.deepEqual(invoice.items.map((item) => item.amount), ["3000000", "6300000", "250000"]);
  assert.deepEqual(invoice.items.map((item) => item.number), [1, 2, 3]);
  assert.deepEqual(invoice.totals, {
    subtotal: "9550000", discount: "477500", taxable: "9072500",
    taxes: [{ name: "PPN", rate: "11", amount: "997975" }, { name: "PPh 23", rate: "-2", amount: "-181450" }],
    tax_total: "816525", shipping: "150000", total: "10039025", amount_paid: "1000000", balance_due: "9039025",
  });
  assert.deepEqual(invoice.flags, { has_period: false, has_quantity: true, has_discount: true, has_taxes: true, show_tax_note: false, has_shipping: true, has_amount_paid: true });
});

test("invoice: cents are kept for two-decimal currencies and the input is not changed", () => {
  const values = { items: [{ description: "Hours", quantity: "7.25", unit_price: "89.99", period: "Nov" }], tax_note: "Not applicable" };
  const invoice = calculateInvoice(values, 2);
  assert.equal(invoice.items[0].amount, "652.43");
  assert.equal(invoice.totals.total, "652.43");
  assert.deepEqual([invoice.flags.has_period, invoice.flags.show_tax_note, invoice.flags.has_taxes], [true, true, false]);
  assert.equal(values.items[0].amount, undefined);
  assert.equal(values.totals, undefined);
});

test("invoice: a given amount that contradicts quantity x unit price is refused, a matching one accepted", () => {
  assert.equal(calculateInvoice({ items: [{ quantity: 2, unit_price: 50, amount: "100.00" }] }, 2).totals.total, "100.00");
  assert.throws(() => calculateInvoice({ items: [{ quantity: 2, unit_price: 50, amount: 120 }] }, 2), (error) => error.kind === "invalid_input" && /items\[0\]\.amount` is 120\.00 but .* is 100\.00/.test(error.message));
});

test("invoice: malformed input is refused with the field's name", () => {
  const badInvoices = [
    [{ items: "x" }, /items/],
    [{ items: [{}] }, /items\[0\]/],
    [{ items: ["text"] }, /items\[0\]/],
    [{ items: [{ quantity: 2 }] }, /items\[0\]\.unit_price/],
    [{ items: [{ amount: "1.000" }], taxes: {} }, /taxes/],
    [{ items: [{ amount: 1 }], taxes: [{ name: "X" }] }, /taxes\[0\]/],
    [{ items: [{ amount: 1 }], taxes: [{ name: "X", rate: 250 }] }, /taxes\[0\]\.rate/],
    [{ items: [{ amount: 1 }], discount: { percent: 5, amount: 1 } }, /discount/],
    [{ items: [{ amount: 1 }], discount: -5 }, /discount/],
    [{ items: [{ amount: 1 }], shipping: "free" }, /shipping/],
    [{ items: Array(MAX_ITEMS + 1).fill({ amount: 1 }) }, /over the limit/],
  ];
  for (const [values, pattern] of badInvoices) assert.throws(() => calculateInvoice(values, 2), (error) => error.kind === "invalid_input" && pattern.test(error.message), JSON.stringify(values).slice(0, 60));
});

test("format settings: defaults follow the language, and bad settings are refused", () => {
  assert.deepEqual(readFormatSettings({}), { language: "en", locale: "en-GB", currency: "USD", decimals: 2, currencyStyle: "auto" });
  assert.deepEqual(readFormatSettings({ language: "ID" }), { language: "id", locale: "id-ID", currency: "IDR", decimals: 0, currencyStyle: "auto" });
  assert.deepEqual(readFormatSettings({ currency: "jpy", locale: "ja-JP", decimals: "0", currency_style: "code" }), { language: "en", locale: "ja-JP", currency: "JPY", decimals: 0, currencyStyle: "code" });
  for (const badValues of [{ language: "fr" }, { currency: "RUPIAH" }, { currency: "R$" }, { decimals: 9 }, { decimals: "two" }, { locale: "not a locale!" }, { currency_style: "words" }]) {
    assert.throws(() => readFormatSettings(badValues), { kind: "invalid_input" }, JSON.stringify(badValues));
  }
});

test("money: IDR and USD in their usual forms, exact for large amounts, with plain spaces", () => {
  const rupiah = readFormatSettings({ language: "id" });
  const dollars = readFormatSettings({ currency: "USD" });
  assert.equal(formatMoney("1500000", rupiah), "Rp 1.500.000");
  assert.equal(formatMoney("-181450", rupiah), "-Rp 181.450");
  assert.equal(formatMoney("1500000", rupiah, "code"), "IDR 1.500.000");
  assert.equal(formatMoney("1050.00", dollars), "USD 1,050.00");
  assert.equal(formatMoney("-20.5", dollars), "-USD 20.50");
  assert.equal(formatMoney("1050", dollars, "symbol"), "$1,050.00");
  assert.equal(formatMoney("12345678901234567.89", dollars), "USD 12,345,678,901,234,567.89");
  assert.equal(formatMoney("9.99", readFormatSettings({ currency: "EUR", locale: "en-GB" })), "€9.99");
  assert.equal(formatMoney("on request", dollars), "on request");
  assert.ok(!/[  ]/.test(formatMoney("1500000", rupiah)));
});

test("numbers and dates follow the locale; text that is not a date or number passes through", () => {
  const indonesian = readFormatSettings({ language: "id" });
  const english = readFormatSettings({});
  assert.equal(formatNumber("2.5", indonesian), "2,5");
  assert.equal(formatNumber("1050", english, 2), "1,050.00");
  assert.equal(formatNumber("3 boxes", english), "3 boxes");
  assert.equal(formatDate("2026-07-31", english), "31 July 2026");
  assert.equal(formatDate("2026-07-31", indonesian), "31 Juli 2026");
  assert.equal(formatDate("2026-07-31T23:30:00+07:00", english, "medium"), "31 Jul 2026");
  assert.equal(formatDate("2026-07-31", english, "short"), "31/07/2026");
  assert.equal(formatDate("2026-07-31", english, "iso"), "2026-07-31");
  assert.equal(formatDate("upon delivery", english), "upon delivery");
  assert.equal(parseIsoDate("2026-02-30"), null);
  assert.throws(() => formatDate("2026-07-31", english, "fancy"), { kind: "invalid_input" });
});
