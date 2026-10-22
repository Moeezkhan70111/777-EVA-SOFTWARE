import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCT_VARIANT_NAMESPACE, deriveProductVariantId } from "./productIdentity.js";

// WHAT THESE PROVE. That one product is one id on every computer, that two products are never
// one id, and that the id is the shape the column already holds. They do NOT prove anything
// about when the id is minted -- that a rename cannot strand one, and that nothing recomputes it
// to find a row, are properties of products.ts and are tested there.

test("the same product is the same id, every time and on every computer", () => {
  const onPc1 = deriveProductVariantId("SK46", "BLACK", "4/6");
  const onPc2 = deriveProductVariantId("SK46", "BLACK", "4/6");

  assert.equal(onPc1, onPc2);
  // The whole point: this is what makes a second computer's push an `on conflict do nothing`
  // instead of VARIANT_IDENTITY_CLASH. A random id would differ here.
  assert.equal(onPc1, deriveProductVariantId("SK46", "BLACK", "4/6"));
});

test("the id is pinned to a value, so a later refactor cannot silently re-mint every product", () => {
  // If this fails, the derivation changed and every product created before the change is now a
  // different product from the same product created after it. That is a migration, not a tidy-up.
  assert.equal(deriveProductVariantId("SK46", "BLACK", "4/6"), "648ebfb6-4b05-548b-aeae-619b6630f88b");
  assert.equal(deriveProductVariantId("SK9", "BLACK", "7/10"), "bed1df71-c70a-5724-aaed-fb5011c82564");
  assert.equal(PRODUCT_VARIANT_NAMESPACE, "6f3a1c2e-8d47-5b90-a1e6-7c4f2d9b0537");
});

test("a different article, colour or size is a different product", () => {
  const base = deriveProductVariantId("SK46", "BLACK", "4/6");
  for (const other of [
    deriveProductVariantId("SK47", "BLACK", "4/6"),
    deriveProductVariantId("SK46", "WHITE", "4/6"),
    deriveProductVariantId("SK46", "BLACK", "7/10"),
  ]) {
    assert.notEqual(other, base);
  }
});

test("the tuple cannot be re-cut: a separator inside a value shifts nothing", () => {
  // Joined on a separator, ("A|B", "C", "D") and ("A", "B|C", "D") would be one id and one
  // product would shadow another. A size genuinely contains "/" already, and nothing stops a
  // colour carrying whatever character a join picked, so the parts are length-prefixed.
  assert.notEqual(deriveProductVariantId("A|B", "C", "D"), deriveProductVariantId("A", "B|C", "D"));
  assert.notEqual(deriveProductVariantId("A", "B", "C/D"), deriveProductVariantId("A", "B/C", "D"));
  assert.notEqual(deriveProductVariantId("AB", "", "C"), deriveProductVariantId("A", "BC", ""));
  assert.notEqual(deriveProductVariantId("SK4", "6BLACK", "4/6"), deriveProductVariantId("SK46", "BLACK", "4/6"));
});

test("it normalises nothing, because the id must collide exactly when the UNIQUE does", () => {
  // product_variants carries UNIQUE (article, color, size) and SQLite compares TEXT case
  // sensitively, so BLACK and black are two legal rows. If this lowercased before hashing they
  // would compute ONE id and the second insert would fail on the primary key -- turning rows the
  // schema allows into a write error. Collision here must mean collision there, byte for byte.
  assert.notEqual(deriveProductVariantId("SK46", "black", "4/6"), deriveProductVariantId("SK46", "BLACK", "4/6"));
  assert.notEqual(deriveProductVariantId("SK46", " BLACK", "4/6"), deriveProductVariantId("SK46", "BLACK", "4/6"));
  // Callers hand over the values they are about to store, already normalised. See products.ts.
});

test("it is a well-formed version 5 UUID, so it sits beside the random ids unremarkably", () => {
  // Nothing in the codebase validates the shape -- checked before this was written -- but the
  // derived and the random ids share one TEXT column and reading them should not be a puzzle.
  const id = deriveProductVariantId("SK46", "BLACK", "4/6");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id.length, 36, "the same length as the 36 ids already stored");
});

test("the empty tuple is still an id, and still its own", () => {
  // Not a case the application reaches -- creation rejects blank values long before here -- but
  // a hash that threw or returned something malformed would be a worse failure than a useless id.
  assert.match(deriveProductVariantId("", "", ""), /^[0-9a-f]{8}-/);
  assert.notEqual(deriveProductVariantId("", "", ""), deriveProductVariantId("", "", "A"));
});
