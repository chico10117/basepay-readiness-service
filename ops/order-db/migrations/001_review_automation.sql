-- x402 automated review queue, result storage, and delivery tracking.
-- The application also applies this schema idempotently at startup so a worker
-- restart cannot run against an incomplete database.

ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS callback_url TEXT;
ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS response_format TEXT NOT NULL DEFAULT 'both';
ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS access_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS paid_service_orders_access_token_hash_idx
  ON paid_service_orders (access_token_hash)
  WHERE access_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_jobs (
  job_id UUID PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES paid_service_orders(order_id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('awaiting_settlement', 'queued', 'processing', 'needs_input',
      'completed', 'failed', 'cancelled')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  priority INTEGER NOT NULL DEFAULT 100,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS review_jobs_queue_idx
  ON review_jobs (status, available_at, priority, created_at);

CREATE TABLE IF NOT EXISTS review_results (
  result_id UUID PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES paid_service_orders(order_id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  verdict TEXT NOT NULL,
  score INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  result_json JSONB NOT NULL,
  report_markdown TEXT NOT NULL,
  target_snapshot JSONB NOT NULL,
  agent_metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  delivery_id UUID PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES paid_service_orders(order_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  destination TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_http_status INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS delivery_attempts_pending_idx
  ON delivery_attempts (status, next_attempt_at, created_at);
