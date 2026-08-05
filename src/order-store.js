import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

const ORDER_DATABASE_URL = String(process.env.ORDER_DATABASE_URL ?? "").trim();
const ORDER_STORE_REQUIRED = process.env.ORDER_STORE_REQUIRED === "true";
const ORDER_ACCESS_TOKEN_PEPPER = String(process.env.ORDER_ACCESS_TOKEN_PEPPER ?? "");
const REVIEW_JOB_MAX_ATTEMPTS = Math.max(1, Number(process.env.REVIEW_JOB_MAX_ATTEMPTS ?? "3"));

const REVIEW_JOB_STATUSES = [
  "awaiting_settlement",
  "queued",
  "processing",
  "needs_input",
  "completed",
  "failed",
  "cancelled",
];

let pool;
let initializationPromise;

export function orderStoreConfigured() {
  return Boolean(ORDER_DATABASE_URL);
}

export function hashAccessToken(value) {
  return sha256(`${ORDER_ACCESS_TOKEN_PEPPER}:${String(value)}`);
}

export async function initializeOrderStore() {
  if (!ORDER_DATABASE_URL) {
    if (ORDER_STORE_REQUIRED) {
      throw new Error("ORDER_DATABASE_URL is required for paid service intake");
    }
    return false;
  }

  if (!initializationPromise) {
    initializationPromise = initializeDatabase().catch(error => {
      initializationPromise = undefined;
      throw error;
    });
  }

  await initializationPromise;
  return true;
}

export async function saveVerifiedOrder(order) {
  const configured = await initializeOrderStore();
  if (!configured) return { stored: false };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        INSERT INTO paid_service_orders (
          order_id,
          service,
          status,
          accepted_at,
          repository_or_url,
          goal,
          contact,
          constraints_text,
          callback_url,
          response_format,
          language,
          access_token_hash,
          request_method,
          request_path,
          payment_fingerprint,
          network,
          asset_contract,
          amount_atomic,
          amount_usd,
          pay_to,
          receipt
        )
        VALUES (
          $1, $2, 'payment_verified', $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb
        )
        ON CONFLICT (payment_fingerprint) DO UPDATE
        SET updated_at = NOW()
        WHERE paid_service_orders.order_id = EXCLUDED.order_id
        RETURNING order_id, status, created_at, updated_at
      `,
      [
        order.orderId,
        order.service,
        order.acceptedAt,
        order.request.repository_or_url,
        order.request.goal,
        order.request.contact || null,
        order.request.constraints || null,
        order.request.callback_url || null,
        order.request.response_format || "both",
        order.request.language || "en",
        order.accessTokenHash || null,
        order.requestMethod,
        order.requestPath,
        order.paymentFingerprint,
        order.payment.networkCaip2,
        order.payment.assetContract || null,
        String(order.payment.expectedAmountAtomic),
        order.payment.expectedAmountUsd,
        order.payment.payTo,
        JSON.stringify(sanitizedReceipt(order.receipt)),
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error("payment authorization conflicts with an existing order");
    }

    await client.query(
      `
        INSERT INTO review_jobs (job_id, order_id, service, status, max_attempts)
        VALUES ($1, $2, $3, 'awaiting_settlement', $4)
        ON CONFLICT (order_id) DO NOTHING
      `,
      [order.jobId, order.orderId, order.service, REVIEW_JOB_MAX_ATTEMPTS],
    );

    await client.query("COMMIT");
    return { stored: true, order: result.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function markOrderSettled(settlement) {
  const configured = await initializeOrderStore();
  if (!configured) return { stored: false };

  return withTransaction(async client => {
    const result = await client.query(
      `
        UPDATE paid_service_orders
        SET
          status = 'paid_intake_received',
          payer_address = COALESCE($2, payer_address),
          network = COALESCE($3, network),
          amount_atomic = COALESCE($4, amount_atomic),
          pay_to = COALESCE($5, pay_to),
          settlement_tx_hash = $6,
          settlement_error = NULL,
          settled_at = COALESCE(settled_at, NOW()),
          updated_at = NOW()
        WHERE order_id = $1
          AND (settlement_tx_hash IS NULL OR settlement_tx_hash = $6)
        RETURNING order_id, status, settlement_tx_hash, settled_at
      `,
      [
        settlement.orderId,
        settlement.payerAddress || null,
        settlement.network || null,
        settlement.amountAtomic ? String(settlement.amountAtomic) : null,
        settlement.payTo || null,
        settlement.transaction,
      ],
    );

    if (result.rowCount !== 1) {
      throw new Error("settled payment does not match a stored order");
    }

    await client.query(
      `
        UPDATE review_jobs
        SET status = 'queued', available_at = NOW(), updated_at = NOW()
        WHERE order_id = $1 AND status = 'awaiting_settlement'
      `,
      [settlement.orderId],
    );

    return { stored: true, order: result.rows[0] };
  });
}

export async function markOrderSettlementFailed(failure) {
  const configured = await initializeOrderStore();
  if (!configured) return { stored: false };

  return withTransaction(async client => {
    const result = await client.query(
      `
        UPDATE paid_service_orders
        SET
          status = 'settlement_failed',
          settlement_error = $2,
          updated_at = NOW()
        WHERE order_id = $1
          AND settlement_tx_hash IS NULL
        RETURNING order_id, status, updated_at
      `,
      [failure.orderId, String(failure.error ?? "settlement failed").slice(0, 2000)],
    );

    await client.query(
      `
        UPDATE review_jobs
        SET status = 'cancelled', last_error = $2, updated_at = NOW()
        WHERE order_id = $1 AND status = 'awaiting_settlement'
      `,
      [failure.orderId, String(failure.error ?? "settlement failed").slice(0, 2000)],
    );

    return { stored: result.rowCount === 1, order: result.rows[0] ?? null };
  });
}

export async function getReviewOrder(orderId, accessToken) {
  const configured = await initializeOrderStore();
  if (!configured || !orderId || !accessToken) return null;

  const tokenHash = hashAccessToken(accessToken);
  const result = await pool.query(
    `
      SELECT
        o.order_id,
        o.service,
        o.status AS payment_status,
        o.repository_or_url,
        o.goal,
        o.contact,
        o.constraints_text,
        o.callback_url,
        o.response_format,
        o.language,
        o.network,
        o.asset_contract,
        o.amount_atomic,
        o.amount_usd,
        o.pay_to,
        o.settlement_tx_hash,
        o.settled_at,
        o.created_at,
        o.updated_at,
        j.job_id,
        j.status AS review_status,
        j.attempt_count,
        j.max_attempts,
        j.started_at,
        j.completed_at,
        j.last_error,
        r.schema_version,
        r.verdict,
        r.score,
        r.result_json,
        r.report_markdown,
        r.target_snapshot,
        r.agent_metadata,
        r.created_at AS result_created_at,
        r.updated_at AS result_updated_at
      FROM paid_service_orders o
      LEFT JOIN review_jobs j ON j.order_id = o.order_id
      LEFT JOIN review_results r ON r.order_id = o.order_id
      WHERE o.order_id = $1 AND o.access_token_hash = $2
    `,
    [orderId, tokenHash],
  );

  if (result.rowCount !== 1) return null;
  return mapReviewOrder(result.rows[0]);
}

export async function claimNextReviewJob(workerId, leaseSeconds = 300) {
  const configured = await initializeOrderStore();
  if (!configured) return null;

  return withTransaction(async client => {
    const candidate = await client.query(
      `
        SELECT j.job_id
        FROM review_jobs j
        JOIN paid_service_orders o ON o.order_id = j.order_id
        WHERE j.status = 'queued'
          AND j.available_at <= NOW()
          AND o.settlement_tx_hash IS NOT NULL
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= NOW())
        ORDER BY j.priority ASC, j.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );

    if (candidate.rowCount !== 1) return null;

    const claimed = await client.query(
      `
        UPDATE review_jobs
        SET
          status = 'processing',
          attempt_count = attempt_count + 1,
          lease_owner = $2,
          lease_expires_at = NOW() + ($3 || ' seconds')::INTERVAL,
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW()
        WHERE job_id = $1
        RETURNING job_id, order_id, service, attempt_count, max_attempts,
          lease_expires_at
      `,
      [candidate.rows[0].job_id, workerId, String(leaseSeconds)],
    );

    const job = await client.query(
      `
        SELECT
          j.job_id,
          j.order_id,
          j.service,
          j.status,
          j.attempt_count,
          j.max_attempts,
          j.lease_expires_at,
          o.repository_or_url,
          o.goal,
          o.contact,
          o.constraints_text,
          o.callback_url,
          o.response_format,
          o.language,
          o.settlement_tx_hash,
          o.network,
          o.amount_usd,
          o.pay_to
        FROM review_jobs j
        JOIN paid_service_orders o ON o.order_id = j.order_id
        WHERE j.job_id = $1
      `,
      [claimed.rows[0].job_id],
    );

    return job.rows[0];
  });
}

export async function heartbeatReviewJob(jobId, workerId, leaseSeconds = 300) {
  const configured = await initializeOrderStore();
  if (!configured) return false;

  const result = await pool.query(
    `
      UPDATE review_jobs
      SET lease_expires_at = NOW() + ($3 || ' seconds')::INTERVAL, updated_at = NOW()
      WHERE job_id = $1 AND lease_owner = $2 AND status = 'processing'
      RETURNING job_id
    `,
    [jobId, workerId, String(leaseSeconds)],
  );
  return result.rowCount === 1;
}

export async function requeueExpiredReviewJobs() {
  const configured = await initializeOrderStore();
  if (!configured) return 0;

  const result = await pool.query(
    `
      UPDATE review_jobs
      SET
        status = 'queued',
        available_at = NOW(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = COALESCE(last_error, 'worker lease expired'),
        updated_at = NOW()
      WHERE status = 'processing'
        AND lease_expires_at < NOW()
      RETURNING job_id
    `,
  );
  return result.rowCount;
}

export async function completeReviewJob({
  jobId,
  orderId,
  workerId,
  result: reviewResult,
  reportMarkdown,
  targetSnapshot,
  agentMetadata,
  status = "completed",
}) {
  const configured = await initializeOrderStore();
  if (!configured) return { stored: false };
  if (!REVIEW_JOB_STATUSES.includes(status)) {
    throw new Error(`invalid review job status: ${status}`);
  }

  return withTransaction(async client => {
    await insertReviewResult(client, {
      orderId,
      reviewResult,
      reportMarkdown,
      targetSnapshot,
      agentMetadata,
    });

    const jobResult = await client.query(
      `
        UPDATE review_jobs
        SET
          status = $4,
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = CASE WHEN $4 IN ('completed', 'needs_input') THEN NOW() ELSE completed_at END,
          last_error = NULL,
          updated_at = NOW()
        WHERE job_id = $1 AND order_id = $2 AND lease_owner = $3
        RETURNING status, completed_at
      `,
      [jobId, orderId, workerId, status],
    );

    if (jobResult.rowCount !== 1) {
      throw new Error("review job lease no longer belongs to this worker");
    }

    if (["completed", "needs_input"].includes(status)) {
      await enqueueDelivery(client, orderId, status);
    }

    return { stored: true, status: jobResult.rows[0].status };
  });
}

export async function failReviewJob({
  jobId,
  workerId,
  error,
  retry = true,
  result: reviewResult = null,
  reportMarkdown = "",
  targetSnapshot = {},
  agentMetadata = {},
}) {
  const configured = await initializeOrderStore();
  if (!configured) return { stored: false };

  return withTransaction(async client => {
    const jobResult = await client.query(
      `
        UPDATE review_jobs
        SET
          status = CASE
            WHEN $3 AND attempt_count < max_attempts THEN 'queued'
            ELSE 'failed'
          END,
          available_at = CASE
            WHEN $3 AND attempt_count < max_attempts
              THEN NOW() + make_interval(
                secs => LEAST(
                  1800,
                  (30 * POWER(2, GREATEST(attempt_count - 1, 0)) + FLOOR(random() * 15))::INTEGER
                )
              )
            ELSE available_at
          END,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = LEFT($2, 2000),
          updated_at = NOW()
        WHERE job_id = $1 AND lease_owner = $4
        RETURNING order_id, status, attempt_count
      `,
      [jobId, String(error ?? "review failed"), Boolean(retry), workerId],
    );
    const job = jobResult.rows[0] ?? null;
    if (job?.status === "failed" && reviewResult) {
      await insertReviewResult(client, {
        orderId: job.order_id,
        reviewResult,
        reportMarkdown,
        targetSnapshot,
        agentMetadata,
      });
      await enqueueDelivery(client, job.order_id, "failed");
    }
    return { stored: jobResult.rowCount === 1, job };
  });
}

export async function claimNextDelivery(workerId) {
  const configured = await initializeOrderStore();
  if (!configured) return null;

  return withTransaction(async client => {
    const result = await client.query(
      `
        SELECT d.delivery_id, d.order_id, d.channel, d.destination,
          d.event_id, d.attempt_count, r.result_json, r.report_markdown,
          o.service, o.callback_url
        FROM delivery_attempts d
        JOIN review_results r ON r.order_id = d.order_id
        JOIN paid_service_orders o ON o.order_id = d.order_id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= NOW()
        ORDER BY d.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    if (result.rowCount !== 1) return null;

    const delivery = result.rows[0];
    await client.query(
      `
        UPDATE delivery_attempts
        SET status = 'sending', attempt_count = attempt_count + 1,
          last_error = NULL, updated_at = NOW()
        WHERE delivery_id = $1
      `,
      [delivery.delivery_id],
    );
    return { ...delivery, worker_id: workerId, attempt_count: delivery.attempt_count + 1 };
  });
}

export async function requeueStaleDeliveries() {
  const configured = await initializeOrderStore();
  if (!configured) return 0;
  const result = await pool.query(
    `
      UPDATE delivery_attempts
      SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW(),
        last_error = COALESCE(last_error, 'delivery lease recovered')
      WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '10 minutes'
      RETURNING delivery_id
    `,
  );
  return result.rowCount;
}

export async function getReviewQueueStats() {
  const configured = await initializeOrderStore();
  if (!configured) return { configured: false };

  const result = await pool.query(`
    SELECT
      (SELECT COALESCE(jsonb_object_agg(status, count), '{}'::jsonb)
       FROM (SELECT status, COUNT(*)::INTEGER AS count FROM review_jobs GROUP BY status) counts) AS jobs,
      (SELECT COUNT(*)::INTEGER FROM delivery_attempts WHERE status IN ('pending', 'sending')) AS pending_deliveries,
      (SELECT COUNT(*)::INTEGER FROM delivery_attempts WHERE status = 'failed') AS failed_deliveries,
      (SELECT MIN(created_at) FROM review_jobs WHERE status = 'queued') AS oldest_queued_at,
      (SELECT COUNT(*)::INTEGER FROM review_jobs WHERE status = 'failed') AS failed_jobs,
      (SELECT COUNT(*)::INTEGER FROM paid_service_orders WHERE settled_at IS NOT NULL) AS settled_orders,
      (SELECT COALESCE(SUM((agent_metadata->'usage'->>'total_tokens')::NUMERIC), 0) FROM review_results) AS agent_tokens,
      (SELECT COALESCE(SUM((agent_metadata->>'estimated_cost_usd')::NUMERIC), 0) FROM review_results) AS estimated_cost_usd,
      (SELECT COALESCE(AVG((agent_metadata->>'duration_seconds')::NUMERIC), 0) FROM review_results) AS average_duration_seconds,
      (SELECT COALESCE(jsonb_object_agg(severity, finding_count), '{}'::jsonb)
       FROM (
         SELECT finding->>'severity' AS severity, COUNT(*)::INTEGER AS finding_count
         FROM review_results r
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.result_json->'findings') = 'array'
             THEN r.result_json->'findings' ELSE '[]'::jsonb END
         ) finding
         WHERE finding->>'severity' IS NOT NULL
         GROUP BY finding->>'severity'
       ) finding_counts) AS findings_by_severity
  `);
  return { configured: true, ...result.rows[0] };
}

export async function markDeliveryDelivered(deliveryId, httpStatus) {
  const configured = await initializeOrderStore();
  if (!configured) return false;
  const result = await pool.query(
    `
      UPDATE delivery_attempts
      SET status = 'delivered', last_http_status = $2, delivered_at = NOW(), updated_at = NOW()
      WHERE delivery_id = $1
      RETURNING delivery_id
    `,
    [deliveryId, httpStatus],
  );
  return result.rowCount === 1;
}

export async function markDeliveryFailed(deliveryId, error, retry = true, httpStatus = null) {
  const configured = await initializeOrderStore();
  if (!configured) return false;
  const result = await pool.query(
    `
      UPDATE delivery_attempts
      SET
        status = CASE WHEN $3 AND attempt_count < 6 THEN 'pending' ELSE 'failed' END,
        next_attempt_at = CASE
          WHEN $3 AND attempt_count < 6 THEN NOW() + make_interval(
            secs => LEAST(
              3600,
              (60 * POWER(2, GREATEST(attempt_count - 1, 0)) + FLOOR(random() * 30))::INTEGER
            )
          )
          ELSE next_attempt_at
        END,
        last_http_status = COALESCE($4, last_http_status),
        last_error = LEFT($2, 2000),
        updated_at = NOW()
      WHERE delivery_id = $1
      RETURNING delivery_id
    `,
    [deliveryId, String(error ?? "delivery failed"), Boolean(retry), httpStatus],
  );
  return result.rowCount === 1;
}

async function insertReviewResult(
  client,
  { orderId, reviewResult, reportMarkdown, targetSnapshot, agentMetadata },
) {
  await client.query(
    `
      INSERT INTO review_results (
        result_id,
        order_id,
        schema_version,
        verdict,
        score,
        result_json,
        report_markdown,
        target_snapshot,
        agent_metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb)
      ON CONFLICT (order_id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        verdict = EXCLUDED.verdict,
        score = EXCLUDED.score,
        result_json = EXCLUDED.result_json,
        report_markdown = EXCLUDED.report_markdown,
        target_snapshot = EXCLUDED.target_snapshot,
        agent_metadata = EXCLUDED.agent_metadata,
        updated_at = NOW()
    `,
    [
      crypto.randomUUID(),
      orderId,
      reviewResult.schema_version,
      reviewResult.verdict,
      reviewResult.score ?? null,
      JSON.stringify(reviewResult),
      reportMarkdown,
      JSON.stringify(targetSnapshot ?? {}),
      JSON.stringify(agentMetadata ?? {}),
    ],
  );
}

async function enqueueDelivery(client, orderId, status) {
  await client.query(
    `
      INSERT INTO delivery_attempts (
        delivery_id, order_id, channel, destination, event_id, status, next_attempt_at
      )
      SELECT $1, o.order_id, 'webhook', o.callback_url, $2, 'pending', NOW()
      FROM paid_service_orders o
      WHERE o.order_id = $3 AND o.callback_url IS NOT NULL
      ON CONFLICT (event_id) DO NOTHING
    `,
    [crypto.randomUUID(), `${orderId}:${status}`, orderId],
  );
}

export async function closeOrderStore() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
  initializationPromise = undefined;
}

async function initializeDatabase() {
  pool = new Pool({
    connectionString: ORDER_DATABASE_URL,
    max: 6,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    allowExitOnIdle: true,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS paid_service_orders (
      order_id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'payment_verified', 'paid_intake_received', 'settlement_failed',
          'in_progress', 'delivered', 'refunded', 'cancelled'
        )
      ),
      accepted_at TIMESTAMPTZ NOT NULL,
      repository_or_url TEXT NOT NULL,
      goal TEXT NOT NULL,
      contact TEXT,
      constraints_text TEXT,
      callback_url TEXT,
      response_format TEXT NOT NULL DEFAULT 'both',
      language TEXT NOT NULL DEFAULT 'en',
      access_token_hash TEXT UNIQUE,
      request_method TEXT NOT NULL,
      request_path TEXT NOT NULL,
      payment_fingerprint TEXT NOT NULL UNIQUE,
      payer_address TEXT,
      network TEXT NOT NULL,
      asset_contract TEXT,
      amount_atomic NUMERIC(78, 0) NOT NULL,
      amount_usd NUMERIC(20, 6),
      pay_to TEXT NOT NULL,
      settlement_tx_hash TEXT UNIQUE,
      settlement_error TEXT,
      receipt JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at TIMESTAMPTZ
    );

    ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS callback_url TEXT;
    ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS response_format TEXT NOT NULL DEFAULT 'both';
    ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
    ALTER TABLE paid_service_orders ADD COLUMN IF NOT EXISTS access_token_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS paid_service_orders_access_token_hash_idx
      ON paid_service_orders (access_token_hash)
      WHERE access_token_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS paid_service_orders_status_created_idx
      ON paid_service_orders (status, created_at DESC);

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
  `);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await callback(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function mapReviewOrder(row) {
  const result = row.result_json
    ? {
        schemaVersion: row.schema_version,
        verdict: row.verdict,
        score: row.score,
        json: row.result_json,
        markdown: row.report_markdown,
        targetSnapshot: row.target_snapshot,
        agentMetadata: row.agent_metadata,
        createdAt: row.result_created_at,
        updatedAt: row.result_updated_at,
      }
    : null;

  return {
    orderId: row.order_id,
    service: row.service,
    payment: {
      status: row.payment_status,
      network: row.network,
      assetContract: row.asset_contract,
      amountAtomic: row.amount_atomic,
      amountUsd: row.amount_usd,
      payTo: row.pay_to,
      settlementTxHash: row.settlement_tx_hash,
      settledAt: row.settled_at,
    },
    request: {
      repository_or_url: row.repository_or_url,
      goal: row.goal,
      contact: row.contact,
      constraints: row.constraints_text,
      callback_url: row.callback_url,
      response_format: row.response_format,
      language: row.language,
    },
    review: {
      jobId: row.job_id,
      status: row.review_status,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      lastError: row.last_error,
    },
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizedReceipt(receipt) {
  const copy = JSON.parse(JSON.stringify(receipt ?? {}));
  if (copy.review && typeof copy.review === "object") {
    delete copy.review.accessToken;
  }
  return copy;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
