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

export async function getOrderStoreHealth() {
  if (!ORDER_DATABASE_URL) return { configured: false, available: false };
  try {
    await initializeOrderStore();
    await pool.query("SELECT 1");
    return { configured: true, available: true };
  } catch {
    return { configured: true, available: false };
  }
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
    let repeatBuyer = false;
    if (settlement.payerAddress) {
      const previousBuyer = await client.query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM paid_service_orders
            WHERE LOWER(payer_address) = LOWER($1)
              AND settled_at IS NOT NULL
              AND order_id <> $2
          ) AS repeat_buyer
        `,
        [settlement.payerAddress, settlement.orderId],
      );
      repeatBuyer = Boolean(previousBuyer.rows[0]?.repeat_buyer);
    }
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

    return { stored: true, order: result.rows[0], repeatBuyer };
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
      (SELECT COUNT(*)::INTEGER FROM review_jobs WHERE status = 'awaiting_settlement') AS awaiting_settlement_jobs,
      (SELECT MIN(created_at) FROM review_jobs WHERE status = 'awaiting_settlement') AS oldest_awaiting_settlement_at,
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

export async function recordServiceHeartbeat(component, metadata = {}) {
  const configured = await initializeOrderStore();
  if (!configured) return false;
  const name = String(component ?? "").trim().slice(0, 100);
  if (!name) throw new Error("heartbeat component is required");
  await pool.query(
    `
      INSERT INTO service_heartbeats (component, observed_at, service_version, commit_sha)
      VALUES ($1, NOW(), $2, $3)
      ON CONFLICT (component) DO UPDATE SET
        observed_at = EXCLUDED.observed_at,
        service_version = EXCLUDED.service_version,
        commit_sha = EXCLUDED.commit_sha
    `,
    [
      name,
      optionalDatabaseText(metadata.version, 100),
      optionalDatabaseText(metadata.commitSha, 100),
    ],
  );
  return true;
}

export async function getServiceHeartbeat(component, maxAgeSeconds = 30) {
  const configured = await initializeOrderStore();
  if (!configured) return { configured: false, available: false };
  const result = await pool.query(
    `
      SELECT observed_at, service_version, commit_sha,
        observed_at >= NOW() - make_interval(secs => $2::INTEGER) AS available
      FROM service_heartbeats
      WHERE component = $1
    `,
    [String(component).slice(0, 100), Math.max(1, Math.floor(Number(maxAgeSeconds) || 30))],
  );
  if (result.rowCount !== 1) {
    return { configured: true, available: false };
  }
  return {
    configured: true,
    available: Boolean(result.rows[0].available),
    version: result.rows[0].service_version ?? null,
    commitSha: result.rows[0].commit_sha ?? null,
  };
}

export async function storeTelemetryEvent(event) {
  const configured = await initializeOrderStore();
  if (!configured) return false;
  await pool.query(
    `
      INSERT INTO telemetry_events (
        event, observed_at, request_id, route, method, status_code, latency_ms,
        price_usd, network, facilitator, discovery_source, error_code,
        buyer_wallet_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `,
    [
      String(event.event).slice(0, 100),
      event.timestamp,
      optionalDatabaseText(event.request_id, 200),
      optionalDatabaseText(event.route, 500),
      optionalDatabaseText(event.method, 20),
      nullableNumber(event.status_code),
      nullableNumber(event.latency_ms),
      nullableNumber(event.price_usd),
      optionalDatabaseText(event.network, 100),
      optionalDatabaseText(event.facilitator, 500),
      optionalDatabaseText(event.discovery_source, 100),
      optionalDatabaseText(event.error_code, 200),
      optionalDatabaseText(event.buyer_wallet_hash, 64),
    ],
  );
  return true;
}

export async function getCommercialMetricsSummary() {
  const configured = await initializeOrderStore();
  if (!configured) {
    return {
      configured: false,
      generatedAt: new Date().toISOString(),
      windows: {
        "7d": emptyMetricsWindow(7),
        "30d": emptyMetricsWindow(30),
      },
    };
  }

  const windows = {};
  for (const days of [7, 30]) {
    const totals = await pool.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE event = 'preflight_inspection_completed')::INTEGER AS inspections,
          COUNT(*) FILTER (WHERE event = 'payment_challenge_served')::INTEGER AS challenges,
          COUNT(*) FILTER (WHERE event = 'payment_settled')::INTEGER AS settlements,
          COUNT(*) FILTER (WHERE event = 'resource_delivered')::INTEGER AS deliveries,
          COUNT(*) FILTER (WHERE event = 'resource_failed')::INTEGER AS errors,
          COUNT(DISTINCT buyer_wallet_hash) FILTER (
            WHERE event = 'payment_settled' AND buyer_wallet_hash IS NOT NULL
          )::INTEGER AS unique_buyers,
          COALESCE(SUM(price_usd) FILTER (WHERE event = 'payment_settled'), 0)::NUMERIC AS revenue_usd,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (
            WHERE event = 'preflight_inspection_completed' AND latency_ms IS NOT NULL
          ) AS latency_p50_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (
            WHERE event = 'preflight_inspection_completed' AND latency_ms IS NOT NULL
          ) AS latency_p95_ms
        FROM telemetry_events
        WHERE observed_at >= NOW() - make_interval(days => $1::INTEGER)
      `,
      [days],
    );
    const recurring = await pool.query(
      `
        SELECT COUNT(*)::INTEGER AS recurring_buyers
        FROM (
          SELECT buyer_wallet_hash
          FROM telemetry_events
          WHERE observed_at >= NOW() - make_interval(days => $1::INTEGER)
            AND event = 'payment_settled'
            AND buyer_wallet_hash IS NOT NULL
          GROUP BY buyer_wallet_hash
          HAVING COUNT(*) > 1
        ) buyers
      `,
      [days],
    );
    const revenue = await pool.query(
      `
        SELECT COALESCE(route, 'unknown') AS route,
          COALESCE(SUM(price_usd), 0)::NUMERIC AS revenue_usd
        FROM telemetry_events
        WHERE observed_at >= NOW() - make_interval(days => $1::INTEGER)
          AND event = 'payment_settled'
        GROUP BY COALESCE(route, 'unknown')
        ORDER BY revenue_usd DESC, route ASC
      `,
      [days],
    );
    windows[`${days}d`] = mapMetricsWindow(
      days,
      totals.rows[0],
      recurring.rows[0],
      revenue.rows,
    );
  }

  return {
    configured: true,
    generatedAt: new Date().toISOString(),
    windows,
  };
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

function optionalDatabaseText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function emptyMetricsWindow(days) {
  return {
    days,
    inspections: 0,
    challenges: 0,
    settlements: 0,
    deliveries: 0,
    errors: 0,
    challengeToSettlementPct: null,
    settlementToDeliveredPct: null,
    uniqueBuyersApprox: 0,
    recurringBuyers: 0,
    revenueUsd: 0,
    revenueByRoute: [],
    latencyMs: { p50: null, p95: null },
  };
}

function mapMetricsWindow(days, totals, recurring, revenueRows) {
  const output = emptyMetricsWindow(days);
  output.inspections = Number(totals.inspections ?? 0);
  output.challenges = Number(totals.challenges ?? 0);
  output.settlements = Number(totals.settlements ?? 0);
  output.deliveries = Number(totals.deliveries ?? 0);
  output.errors = Number(totals.errors ?? 0);
  output.challengeToSettlementPct = percentage(output.settlements, output.challenges);
  output.settlementToDeliveredPct = percentage(output.deliveries, output.settlements);
  output.uniqueBuyersApprox = Number(totals.unique_buyers ?? 0);
  output.recurringBuyers = Number(recurring.recurring_buyers ?? 0);
  output.revenueUsd = Number(totals.revenue_usd ?? 0);
  output.revenueByRoute = revenueRows.map(row => ({
    route: row.route,
    revenueUsd: Number(row.revenue_usd ?? 0),
  }));
  output.latencyMs = {
    p50: totals.latency_p50_ms === null ? null : Math.round(Number(totals.latency_p50_ms)),
    p95: totals.latency_p95_ms === null ? null : Math.round(Number(totals.latency_p95_ms)),
  };
  return output;
}

function percentage(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}
