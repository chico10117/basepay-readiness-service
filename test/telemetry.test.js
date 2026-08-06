import assert from "node:assert/strict";
import test from "node:test";

import { serviceRuntime } from "../src/service-runtime.js";
import { createTelemetry, sanitizeEvent } from "../src/telemetry.js";

test("runtime identity normalizes release metadata", () => {
  assert.deepEqual(
    serviceRuntime({
      SERVICE_VERSION: "1.2.3",
      GIT_COMMIT_SHA: "abc123",
      DEPLOYED_AT: "2026-08-06T01:02:03Z",
    }),
    {
      service: "x402-preflight",
      version: "1.2.3",
      commitSha: "abc123",
      deployedAt: "2026-08-06T01:02:03.000Z",
    },
  );
});

test("telemetry allowlists fields, hashes buyers, redacts facilitator URLs, and fails open", async () => {
  const logs = [];
  const errors = [];
  const telemetry = createTelemetry({
    buyerPepper: "test-only-pepper",
    now: () => new Date("2026-08-06T00:00:00.000Z"),
    logger: {
      log: value => logs.push(JSON.parse(value)),
      error: value => errors.push(JSON.parse(value)),
    },
    store: () => {
      throw new Error("database unavailable");
    },
  });
  const buyerHash = telemetry.buyerWalletHash(
    "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9",
  );
  const recorded = telemetry.record("payment_settled", {
    request_id: "req_telemetry",
    route: "/api/x402/preflight/audit",
    method: "POST",
    status_code: 200,
    price_usd: 0.05,
    facilitator: "https://user:secret@facilitator.example/supported?api_key=secret",
    buyer_wallet_hash: buyerHash,
    authorization: "Bearer must-not-appear",
    cookie: "must-not-appear",
  });

  assert.match(buyerHash, /^[a-f0-9]{64}$/);
  assert.equal(recorded.facilitator, "https://facilitator.example/supported");
  assert.equal("authorization" in recorded, false);
  assert.equal("cookie" in recorded, false);
  assert.equal(JSON.stringify(logs).includes("must-not-appear"), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors[0].error_code, "TELEMETRY_STORE_FAILED");
});

test("telemetry rejects invalid buyer hashes from persisted events", () => {
  const event = sanitizeEvent({
    event: "payment_settled",
    timestamp: "2026-08-06T00:00:00.000Z",
    buyer_wallet_hash: "0xraw-wallet",
    discovery_source: "authorization=Bearer secret",
  });
  assert.equal("buyer_wallet_hash" in event, false);
  assert.equal("discovery_source" in event, false);
});
