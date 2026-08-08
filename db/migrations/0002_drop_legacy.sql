-- Clean up legacy tables.
DROP TABLE legacy_orders;
ALTER TABLE users DROP COLUMN legacy_flag;
