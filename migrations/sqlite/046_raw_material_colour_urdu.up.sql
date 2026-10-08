-- A raw material's Colour attribute is auto-translated to Urdu at print time
-- (colorValueInUrdu, apps/desktop/src/renderer/utils/urdu.ts), but the dictionary behind that
-- can get a particular shade wrong. This column lets an operator store a manual correction
-- when entering the material, which wins over the automatic translation from then on -- see
-- materialLabelAttributes in apps/desktop/src/renderer/features/rawMaterial/rawMaterial.ts.
-- Not folded into inventorySignature/signature_hash: it is a display correction, not part of
-- what makes this material a different material from another.
ALTER TABLE inventory_item_values ADD COLUMN text_value_urdu TEXT;
