import pg from "pg";

const { Pool } = pg;

const ORDER_DATABASE_URL = String(process.env.ORDER_DATABASE_URL ?? "").trim();
const ORDER_STORE_REQUIRED = process.env.ORDER_STORE_REQUIRED === "true";

let pool;
let initializationPromise;

export function orderStoreConfigured() {
  return Boolean(ORDER_DATABASE_URL);
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

  const result = await pool.query(
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
        $1, $2, 'payment_verified', $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16::jsonb
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
      order.requestMethod,
      order.requestPath,
      order.paymentFingerprint,
      order.payment.networkCaip2,
      order.payment.assetContract || null,
      String(order.payment.expectedAmountAtomic),
      order.payment.expectedAmountUsd,
      order.payment.payTo,
      JSON.stringify(order.receipt),
    ],
  );

  if (result.rowCount !== 1) {
    throw new Error("payment authorization conflicts with an existing order");
  }

  return { stored: true, order: result.rows[0] };
}

export async function markOrderSettled(settlement) {
  const configured = await initializeOrderStore();
  if (!configured) return { stored: false };

  const result = await pool.query(
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

  return { stored: true, order: result.rows[0] };
}

export async function markOrderSettlementFailed(failure) {
  const configured = await initializeOrderStore();
  if (!configured) return { stored: false };

  const result = await pool.query(
    `
      UPDATE paid_service_orders
      SET
        status = 'settlement_failed',
        settlement_error = $2,
        updated_at = NOW()
      WHERE order_id = $1
        AND status <> 'paid_intake_received'
      RETURNING order_id, status, updated_at
    `,
    [failure.orderId, String(failure.error ?? "settlement failed").slice(0, 2000)],
  );

  return { stored: result.rowCount === 1, order: result.rows[0] ?? null };
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
    max: 4,
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
          'payment_verified',
          'paid_intake_received',
          'settlement_failed',
          'in_progress',
          'delivered',
          'refunded',
          'cancelled'
        )
      ),
      accepted_at TIMESTAMPTZ NOT NULL,
      repository_or_url TEXT NOT NULL,
      goal TEXT NOT NULL,
      contact TEXT,
      constraints_text TEXT,
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

    CREATE INDEX IF NOT EXISTS paid_service_orders_status_created_idx
      ON paid_service_orders (status, created_at DESC);
  `);
}
