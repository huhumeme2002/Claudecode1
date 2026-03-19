-- Performance indexes for usage_logs table
-- Run this MANUALLY on the PostgreSQL server:
--   psql <connection_string> -f scripts/add-performance-indexes.sql

-- 1. Create IMMUTABLE helper: timestamptz → Vietnam date (UTC+7)
-- Must use plpgsql (not sql) to prevent inlining — PostgreSQL inlines
-- SQL functions and checks internal volatility, rejecting AT TIME ZONE.
-- plpgsql is opaque to the planner, so it trusts our IMMUTABLE declaration.
CREATE OR REPLACE FUNCTION vn_date(ts timestamptz) RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
BEGIN
  RETURN (ts AT TIME ZONE INTERVAL '7 hours')::date;
END;
$$;

-- 2. Expression index for admin dashboard: GROUP BY vn_date across all keys
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_datevn
  ON usage_logs (vn_date(created_at));

-- 3. Expression index for user chart: GROUP BY vn_date filtered by api_key_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_apikey_datevn
  ON usage_logs (api_key_id, vn_date(created_at));

-- 4. Composite index for summary: GROUP BY model_id filtered by api_key_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_apikey_model
  ON usage_logs (api_key_id, model_id);
