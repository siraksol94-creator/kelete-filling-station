-- Migration: Add per-product barcode UB settings
-- Run this once against your PostgreSQL database

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS ub_number_start   INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ub_number_length  INTEGER DEFAULT 6,
  ADD COLUMN IF NOT EXISTS ub_quantity_start  INTEGER DEFAULT 7,
  ADD COLUMN IF NOT EXISTS ub_quantity_length INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ub_decimal_start   INTEGER DEFAULT 2;

-- ub_quantity_length = 0 means no weight embedded (regular barcode)
-- Example for "2 000006 009982":
--   ub_number_start=1, ub_number_length=6  → code at positions 1-6 = "000006"
--   ub_quantity_start=7, ub_quantity_length=5, ub_decimal_start=2 → weight "00998" → "00.998" = 0.998 kg
