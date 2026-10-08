# Discount Hierarchy Bug - Analysis & Debug Plan

## Summary
The discount resolution hierarchy is **correctly implemented** in the backend code. The issue is likely **data-related** rather than a logic bug.

## Current Hierarchy (Verified Correct)
```
1. ARTICLE (specific article + size + color) ✓
2. ARTICLE_SERIES                            ✓
3. PRICE_RANGE                               ✓
4. PRODUCT_GROUP                             ✓
5. NONE                                      ✓
```

Each tier is checked in order, and the first match wins.

## Code Analysis

### resolveDiscount Method (lines 2157-2277)
The method correctly:
1. Checks ARTICLE discount (ALL_SIZES then SEPARATE_SIZES)
2. If not found, checks ARTICLE_SERIES discount
3. If not found, checks PRICE_RANGE discount
4. If not found, checks PRODUCT_GROUP discount
5. Returns NONE if nothing matches

**Each check has an early return, so the cascade is correct.**

### resolveProductDiscount Wrapper (lines 2278-2293)
Fetches product data and passes to resolveDiscount:
- `article` from product.article
- `size` from product.size
- `productGroupId` from product.groupId
- `articleSeriesId` from product.articleSeriesId
- `applicablePrice` from product.sellingPrice (pair price)

## Why Series/Price Range Might Not Work

### Scenario 1: Missing articleSeriesId
**Problem**: The product variant record for `SK12/4/6/GREEN` doesn't have `article_series_id` populated.

**How to verify**:
```sql
SELECT article_series_id 
FROM product_variants 
WHERE article = 'SK12' AND size = '4/6' AND color = 'GREEN';
```

**Solution**: Update the product master to set the article series.

**Fallback logic**: The code tries to find articleSeriesId from other variants of the same article:
```typescript
if (!articleSeriesId) {
  const seriesRow = this.db
    .prepare(`SELECT article_series_id FROM product_variants 
              WHERE article = ? AND article_series_id IS NOT NULL ...`)
    .get(input.article);
  if (seriesRow) articleSeriesId = seriesRow.article_series_id;
}
```

### Scenario 2: Article Series ID Mismatch
**Problem**: The discount rule uses a different `article_series_id` than the product.

**How to verify**:
```sql
-- Get product's series ID
SELECT article_series_id FROM product_variants 
WHERE article = 'SK12' LIMIT 1;

-- Get discount rule's series ID
SELECT article_series_id FROM party_article_series_discounts 
WHERE party_id = (SELECT id FROM parties WHERE party_name = 'mama');

-- They must match!
```

**Solution**: Update either the product or the discount rule to use the correct series ID.

### Scenario 3: Missing or NULL sellingPrice
**Problem**: The product doesn't have `selling_price` set, so price range check is skipped.

**How to verify**:
```sql
SELECT selling_price 
FROM product_variants 
WHERE article = 'SK12' AND size = '4/6' AND color = 'GREEN';
```

**Solution**: Update the product's selling price.

### Scenario 4: Price Range Configuration Wrong
**Problem**: The price range in the discount rule doesn't include the product's selling price.

**Example**:
- Product selling price: 488 (pair)
- Configured range: 500-510 (doesn't include 488!)

**How to verify**:
```sql
-- Get product price
SELECT selling_price FROM product_variants 
WHERE article = 'SK12' AND size = '4/6' AND color = 'GREEN';

-- Get price ranges for mama
SELECT start_price, end_price, discount_per_pair 
FROM party_price_range_discounts 
WHERE party_id = (SELECT id FROM parties WHERE party_name = 'mama');

-- Verify: start_price <= 488 AND end_price >= 488
```

**Solution**: Update the price range to include 488 (e.g., 480-510 or 400-500).

### Scenario 5: Wrong Party ID
**Problem**: The discount rules are configured for a different party ID.

**How to verify**:
```sql
SELECT id FROM parties WHERE party_name = 'mama';
-- Compare with party_id in discount tables
```

**Solution**: Update discount rules to use the correct party ID.

## Debug Logging Added

I've added comprehensive console logging to trace the exact flow:

### What You'll See:
```
[resolveProductDiscount] Product data: {
  id: '...',
  article: 'SK12',
  size: '4/6',
  color: 'GREEN',
  sellingPrice: 488,
  articleSeriesId: '<UUID>' or null,
  groupId: '<UUID>' or null
}

[resolveDiscount] INPUT: {
  partyId: '<UUID>',
  article: 'SK12',
  size: '4/6',
  articleSeriesId: '<UUID>' or undefined,
  productGroupId: '<UUID>' or undefined,
  applicablePrice: 488
}

[resolveDiscount] Checking ARTICLE discount for: SK12
[resolveDiscount] ✓ ARTICLE (SEPARATE_SIZES) found: 50
-- OR --
[resolveDiscount] ✗ ARTICLE not found
[resolveDiscount] Checking ARTICLE_SERIES discount for: <UUID>
[resolveDiscount] ✓ ARTICLE_SERIES found: 40
-- OR --
[resolveDiscount] ✗ ARTICLE_SERIES not found
-- OR --
[resolveDiscount] ✗ ARTICLE_SERIES skipped (no articleSeriesId)

[resolveDiscount] Checking PRICE_RANGE discount for price: 488
[resolveDiscount] ✓ PRICE_RANGE found: 35 (range: 488-510)
-- OR --
[resolveDiscount] ✗ PRICE_RANGE not found
-- OR --
[resolveDiscount] ✗ PRICE_RANGE skipped (no applicablePrice)

[resolveDiscount] Checking PRODUCT_GROUP discount for: <UUID>
[resolveDiscount] ✓ PRODUCT_GROUP found: 30
-- OR --
[resolveDiscount] ✗ PRODUCT_GROUP not found

[resolveDiscount] → NONE
```

## Next Steps

1. **Run the app**: `npm run dev`
2. **Test with real data**: Select mama + SK12/4/6/GREEN in Sale Voucher
3. **Copy the console output** from the terminal
4. **Send me the output** so I can diagnose the exact issue

Based on the output, I'll know:
- ✅ What IDs the product actually has
- ✅ What price is being checked
- ✅ Which discount checks are running
- ✅ Which checks are being skipped and why
- ✅ Which checks are running but not finding matches

Then I can either:
- Fix the data (update product/discount records)
- Fix the query logic (if there's an actual bug)
- Add missing fallback handling

## Expected Outcomes

### If articleSeriesId is NULL:
```
[resolveDiscount] ✗ ARTICLE_SERIES skipped (no articleSeriesId)
```
→ Need to set article_series_id on the product

### If articleSeriesId exists but no match:
```
[resolveDiscount] Checking ARTICLE_SERIES discount for: abc-123-def
[resolveDiscount] ✗ ARTICLE_SERIES not found
```
→ Discount rule doesn't exist or uses a different series ID

### If sellingPrice is NULL:
```
[resolveDiscount] ✗ PRICE_RANGE skipped (no applicablePrice)
```
→ Need to set selling_price on the product

### If price exists but no match:
```
[resolveDiscount] Checking PRICE_RANGE discount for price: 488
[resolveDiscount] ✗ PRICE_RANGE not found
```
→ No price range configured that includes 488

## Files Modified

1. **packages/data/src/sqliteDatabase.ts**
   - Added debug logging to `resolveDiscount` method (lines ~2157-2277)
   - Added debug logging to `resolveProductDiscount` wrapper (lines ~2278-2293)

2. **Build**: Already compiled and ready to test

## Rollback (if needed)

To remove debug logging after diagnosis:
```bash
git checkout packages/data/src/sqliteDatabase.ts
npm run build
```
