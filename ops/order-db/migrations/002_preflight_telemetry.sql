-- Optional, non-blocking commercial telemetry and component liveness.
-- Only allowlisted aggregate fields are stored; raw requests, payment
-- authorizations, signatures, tokens, cookies, and wallet addresses are not.

CREATE TABLE IF NOT EXISTS service_heartbeats (
  component TEXT PRIMARY KEY,
  observed_at TIMESTAMPTZ NOT NULL,
  service_version TEXT,
  commit_sha TEXT
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id BIGSERIAL PRIMARY KEY,
  event TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  request_id TEXT,
  route TEXT,
  method TEXT,
  status_code INTEGER,
  latency_ms INTEGER,
  price_usd NUMERIC(20, 6),
  network TEXT,
  facilitator TEXT,
  discovery_source TEXT,
  error_code TEXT,
  buyer_wallet_hash TEXT
);

CREATE INDEX IF NOT EXISTS telemetry_events_observed_idx
  ON telemetry_events (observed_at DESC, event);

CREATE INDEX IF NOT EXISTS telemetry_events_buyer_idx
  ON telemetry_events (buyer_wallet_hash, observed_at DESC)
  WHERE buyer_wallet_hash IS NOT NULL;
