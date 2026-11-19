import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilterExpression, quoteFilterValue, validateOrder } from "../lib/postgrest-query.mjs";

const isInvalidInput = (pattern) => (error) => error.kind === "invalid_input" && pattern.test(error.message);

test("quoteFilterValue wraps every value in double quotes and escapes backslash and double quote", () => {
  assert.equal(quoteFilterValue("plain"), '"plain"');
  assert.equal(quoteFilterValue("a,b.c:d(e)*"), '"a,b.c:d(e)*"');
  assert.equal(quoteFilterValue('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteFilterValue("back\\slash"), '"back\\\\slash"');
  assert.equal(quoteFilterValue(42), '"42"');
  assert.equal(quoteFilterValue(true), '"true"');
});

test("buildFilterExpression joins filters into one and=(...) group with quoted values", () => {
  const expression = buildFilterExpression([
    { column: "status", operator: "eq", value: "open" },
    { column: "age", operator: "gte", value: 18 },
  ]);
  assert.equal(expression, '(status.eq."open",age.gte."18")');
});

test("values cannot inject operators or extra conditions", () => {
  const expression = buildFilterExpression([{ column: "name", operator: "eq", value: 'x",id.gt.0,or(role.eq.admin' }]);
  assert.equal(expression, '(name.eq."x\\",id.gt.0,or(role.eq.admin")');
});

test("in takes a list of quoted values; is takes null, true, false or unknown unquoted", () => {
  assert.equal(buildFilterExpression([{ column: "id", operator: "in", value: [1, "a,b"] }]), '(id.in.("1","a,b"))');
  assert.equal(buildFilterExpression([{ column: "deleted_at", operator: "is", value: null }]), "(deleted_at.is.null)");
  assert.equal(buildFilterExpression([{ column: "active", operator: "is", value: "TRUE" }]), "(active.is.true)");
  assert.throws(() => buildFilterExpression([{ column: "a", operator: "is", value: "1 or 1" }]), isInvalidInput(/null, true, false or unknown/));
  assert.throws(() => buildFilterExpression([{ column: "a", operator: "in", value: "1,2" }]), isInvalidInput(/list/));
  assert.throws(() => buildFilterExpression([{ column: "a", operator: "in", value: [] }]), isInvalidInput(/list/));
});

test("negate adds not., and full-text search takes an optional language", () => {
  assert.equal(buildFilterExpression([{ column: "status", operator: "eq", value: "done", negate: true }]), '(status.not.eq."done")');
  assert.equal(buildFilterExpression([{ column: "body_tsv", operator: "fts", value: "cat & dog", language: "english" }]), '(body_tsv.fts(english)."cat & dog")');
  assert.throws(() => buildFilterExpression([{ column: "t", operator: "fts", value: "x", language: "en)" }]), isInvalidInput(/language/));
  assert.throws(() => buildFilterExpression([{ column: "t", operator: "eq", value: "x", language: "english" }]), isInvalidInput(/language/));
});

test("columns must be identifiers, optionally with JSON arrows", () => {
  assert.equal(buildFilterExpression([{ column: "data->>city", operator: "eq", value: "Bandung" }]), '(data->>city.eq."Bandung")');
  assert.equal(buildFilterExpression([{ column: "data->tags->0", operator: "eq", value: "x" }]), '(data->tags->0.eq."x")');
  for (const column of ["a.b", "a,b", "or(x", "a b", "", "1abc", "a->", "a->>b c"]) {
    assert.throws(() => buildFilterExpression([{ column, operator: "eq", value: "x" }]), isInvalidInput(/column/), column);
  }
});

test("unknown operators, missing values and non-object filters are refused", () => {
  assert.throws(() => buildFilterExpression([{ column: "a", operator: "or", value: "x" }]), isInvalidInput(/operator/));
  assert.throws(() => buildFilterExpression([{ column: "a", operator: "eq" }]), isInvalidInput(/value/));
  assert.throws(() => buildFilterExpression([{ column: "a", operator: "eq", value: null }]), isInvalidInput(/is/));
  assert.throws(() => buildFilterExpression([{ column: "a", operator: "eq", value: { nested: 1 } }]), isInvalidInput(/value/));
  assert.throws(() => buildFilterExpression(["a=eq.1"]), isInvalidInput(/object/));
});

test("an empty filter list gives no expression", () => {
  assert.equal(buildFilterExpression([]), undefined);
  assert.equal(buildFilterExpression(undefined), undefined);
});

test("validateOrder accepts column[.asc|.desc][.nullsfirst|.nullslast] lists only", () => {
  assert.equal(validateOrder("created_at.desc,id"), "created_at.desc,id");
  assert.equal(validateOrder("score.desc.nullslast, name.asc"), "score.desc.nullslast,name.asc");
  assert.equal(validateOrder("data->>age.desc"), "data->>age.desc");
  for (const order of ["id;drop", "id.sideways", "id.desc&select=*", "a,,b"]) {
    assert.throws(() => validateOrder(order), isInvalidInput(/order/), order);
  }
});
