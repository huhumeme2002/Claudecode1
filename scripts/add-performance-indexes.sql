-- Performance indexes for usage_logs table
-- Run this MANUALLY on the PostgreSQL server:
--   psql <connection_string> -f scripts/add-performance-indexes.sql

-- Helper function for timezone conversion in queries (UTC+7, no DST)
CREATE OR REPLACE FUNCTION vn_date(ts timestamptz) RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
BEGIN
  RETURN (ts AT TIME ZONE INTERVAL '7 hours')::date;
END;
$$;

-- Composite index for summary: GROUP BY model_id filtered by api_key_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_apikey_model
  ON usage_logs (api_key_id, model_id);

-- NOTE: Expression indexes on vn_date(created_at) are not possible because
-- PostgreSQL marks AT TIME ZONE as STABLE even inside plpgsql IMMUTABLE wrappers.
-- This is OK — the existing indexes on [created_at] and [api_key_id, created_at]
-- handle the WHERE clause filtering. GROUP BY then processes only the filtered
-- rows (typically <5000 for 30 days per key), which is fast without an index.
