ALTER TABLE cash_voucher_lines ADD COLUMN bank_account_title TEXT NOT NULL DEFAULT '';
ALTER TABLE cash_voucher_lines ADD COLUMN cheque_number TEXT NOT NULL DEFAULT '';
ALTER TABLE cash_voucher_lines ADD COLUMN cheque_date TEXT NOT NULL DEFAULT '';
ALTER TABLE cash_voucher_lines ADD COLUMN online_from TEXT NOT NULL DEFAULT '';
ALTER TABLE cash_voucher_lines ADD COLUMN online_to TEXT NOT NULL DEFAULT '';
ALTER TABLE cash_voucher_lines ADD COLUMN reference_no TEXT NOT NULL DEFAULT '';
