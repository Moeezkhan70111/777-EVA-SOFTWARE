import crypto from "node:crypto";

// A PRODUCT VARIANT'S ID IS DERIVED FROM WHAT THE PRODUCT IS.
//
// WHY. Until 2026-10-23 a new variant's id was crypto.randomUUID(). Every computer starts from
// an empty database (docs/36: never copy the data folder), so creating "the same" product
// through the Product form on two computers produced two ids for one product -- and the cloud
// holds product_variants under UNIQUE (article, color, size), so the second computer's push was
// refused VARIANT_IDENTITY_CLASH and every carton of that product with it.
//
// The cure was either a seed that carries ids across (productVariantSeed.ts) or somebody merging
// two products by hand. Deriving the id from the tuple removes the problem instead of handling
// it: two computers that each create SK46 BLACK 4/6 compute the SAME id, the second push is an
// ordinary `on conflict (id) do nothing`, and they converge with nobody deciding anything.
//
// DERIVE ONCE, AT CREATION, AND STORE IT. NEVER RECOMPUTE IT TO FIND A ROW.
//
// This is the one rule that matters here. An article and size CAN still change after creation:
// renameArticleSize (products.ts) rewrites them on every colour of a product. It refuses once
// any qr_codes row carries that article and size, and a variant cannot reach the cloud without
// one -- a production scan is the only thing that pushes a variant, and even an adopted carton
// writes a qr_codes row -- so a variant that has reached the cloud can never be renamed, and a
// stored derived id can never go stale there.
//
// But a variant renamed BEFORE it ever had a QR code keeps the id it was created with, and that
// id no longer matches its own tuple. Harmless while the id is only ever stored and compared.
// Fatal the moment anything recomputes the hash to resolve a product: that renamed variant would
// become unfindable, and a second row would be created beside it. Every lookup in the codebase
// today is a WHERE article/color/size clause, and it must stay that way.
//
// So: this function is for MINTING an id, never for finding one. There is deliberately no
// `findVariantByDerivedId` here, and there should not be one.
//
// THE INPUT IS THE STORED TUPLE, NOT THE TYPED ONE.
//
// The id must collide exactly when UNIQUE (article, color, size) collides -- byte for byte. So
// callers pass the same normalised strings they are about to write to the columns, and this
// function normalises nothing itself. Normalising here would be worse than useless: lowercase
// the colour before hashing and two locally legal rows (BLACK and black) would compute one id
// and the second insert would fail on the primary key instead of being allowed as it is today.

/**
 * The namespace for 777 ERP product variants, generated once and fixed for ever.
 *
 * Changing this value re-mints every id derived after the change, so a product created before it
 * and after it would be two products. It is a constant, not a setting.
 */
export const PRODUCT_VARIANT_NAMESPACE = "6f3a1c2e-8d47-5b90-a1e6-7c4f2d9b0537";

/**
 * Packs the tuple into one unambiguous string.
 *
 * Length-prefixed rather than joined on a separator. A size genuinely contains "/" (7/10), and
 * nothing stops a colour containing whatever character we picked as a separator -- at which
 * point ("A|B", "C", "D") and ("A", "B|C", "D") would hash to the same id and one product would
 * shadow another. With the length in front there is exactly one way to read the string back.
 */
function packTuple(article: string, color: string, size: string): string {
  return [article, color, size].map((part) => `${String(part.length)}:${part}`).join("");
}

/**
 * The id for a product variant, derived from the tuple that identifies it.
 *
 * A UUID version 5 (SHA-1 over a namespace and a name), so it is the same shape as the random
 * ids minted before this existed and nothing that stores or compares one can tell the
 * difference. Nothing in the codebase validates the shape, but the ids sit beside each other in
 * the same column and reading them should not be a puzzle.
 *
 * Pass the values exactly as they will be stored. See the note above on why.
 */
export function deriveProductVariantId(article: string, color: string, size: string): string {
  const namespaceBytes = Buffer.from(PRODUCT_VARIANT_NAMESPACE.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(packTuple(article, color, size), "utf8");

  const hash = crypto.createHash("sha1").update(namespaceBytes).update(nameBytes).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));

  // Version 5 in the high nibble of byte 6, and the RFC 4122 variant in the top bits of byte 8.
  // Without these it is a bare hash that merely looks like a UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}
