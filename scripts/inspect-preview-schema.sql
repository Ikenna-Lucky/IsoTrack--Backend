-- In Neon's SQL Editor, select the PREVIEW branch first.
-- This transaction reads catalog metadata only; it does not modify the schema.
BEGIN TRANSACTION READ ONLY;

SELECT
  table_schema,
  table_name
FROM
  information_schema.tables
WHERE
  table_schema IN ('public', 'drizzle')
  AND table_type = 'BASE TABLE'
ORDER BY
  table_schema,
  table_name;

SELECT
  to_regclass ('drizzle.__drizzle_migrations') AS migration_ledger;

SELECT
  table_name,
  column_name,
  data_type,
  is_nullable
FROM
  information_schema.columns
WHERE
  table_schema = 'public'
  AND table_name IN (
    'users',
    'businesses',
    'drivers',
    'shipments',
    'payments'
  )
ORDER BY
  table_name,
  ordinal_position;

COMMIT;

-- Only if migration_ledger above is NOT NULL, run separately:
-- SELECT id, hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id;
-- Do not insert ledger records, reset a schema or run migrations based only on names.