-- Performance indexes for usage_logs table
-- Run this MANUALLY on the PostgreSQL server:
--   psql $DATABASE_URL -f scripts/add-performance-indexes.sql
--
-- These use CONCURRENTLY to avoid locking the table during creation.
-- Each index may take several minutes on large tables.
--
-- NOTE: Uses fixed UTC offset '+07' instead of 'Asia/Ho_Chi_Minh'
-- because PostgreSQL requires IMMUTABLE expressions for indexes.
-- Vietnam does not observe DST, so +07 is always correct.

-- 1. Expression index for admin dashboard: GROUP BY date (VN timezone) across all keys
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_datevn
  ON usage_logs (((created_at AT TIME ZONE '+07')::date));

-- 2. Expression index for user chart: GROUP BY date (VN timezone) filtered by api_key_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_apikey_datevn
  ON usage_logs (api_key_id, ((created_at AT TIME ZONE '+07')::date));

-- 3. Composite index for summary: GROUP BY model_id filtered by api_key_id
-- (also added to Prisma schema — this is a backup if prisma db push hasn't run yet)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usage_logs_apikey_model
  ON usage_logs (api_key_id, model_id);
