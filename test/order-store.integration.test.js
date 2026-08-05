import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const databaseUrl = process.env.TEST_ORDER_DATABASE_URL;

test(
  "persists, queues, claims, completes, and authenticates a review order",
  { skip: !databaseUrl },
  async () => {
    process.env.ORDER_DATABASE_URL = databaseUrl;
    process.env.ORDER_STORE_REQUIRED = "true";
    const store = await import(`../src/order-store.js?integration=${Date.now()}`);
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    const orderId = `test-${crypto.randomUUID()}`;
    const accessToken = crypto.randomBytes(32).toString("base64url");
    const acceptedAt = new Date().toISOString();

    try {
      await store.initializeOrderStore();
      await store.saveVerifiedOrder({
        orderId,
        jobId: crypto.randomUUID(),
        service: "Base USDC x402 Quick Review",
        acceptedAt,
        request: {
          repository_or_url: "vercel/next.js",
          goal: "Review x402",
          callback_url: "https://buyer.example/callback",
          response_format: "both",
          language: "en",
        },
        requestMethod: "POST",
        requestPath: "/api/x402/services/quick-review",
        paymentFingerprint: crypto.randomBytes(32).toString("hex"),
        accessTokenHash: store.hashAccessToken(accessToken),
        payment: {
          networkCaip2: "eip155:8453",
          assetContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          expectedAmountAtomic: "50000000",
          expectedAmountUsd: 50,
          payTo: "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9",
        },
        receipt: { orderId, review: { accessToken } },
      });
      await store.markOrderSettled({
        orderId,
        transaction: `0x${crypto.randomBytes(32).toString("hex")}`,
        payerAddress: "0x0000000000000000000000000000000000000001",
        network: "eip155:8453",
        amountAtomic: "50000000",
        payTo: "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9",
      });
      const job = await store.claimNextReviewJob("integration-test", 300);
      assert.equal(job.order_id, orderId);
      const result = {
        schema_version: "x402-review-result/v1",
        order_id: orderId,
        status: "completed",
        service: "Base USDC x402 Quick Review",
        goal: "Review x402",
        verdict: "ready",
        score: 100,
        summary: "Test result",
        checks: [],
        findings: [],
        next_steps: ["Keep testing"],
        limitations: ["Synthetic test"],
        target_snapshot: { type: "test" },
        agent: { runner_version: "test", provider: "test", model: "test" },
        completed_at: new Date().toISOString(),
      };
      await store.completeReviewJob({
        jobId: job.job_id,
        orderId,
        workerId: "integration-test",
        result,
        reportMarkdown: "# Test result",
        targetSnapshot: { type: "test" },
        agentMetadata: { provider: "test" },
      });
      const delivery = await store.claimNextDelivery("integration-test");
      assert.equal(delivery.order_id, orderId);
      await store.markDeliveryFailed(
        delivery.delivery_id,
        "webhook returned HTTP 500",
        true,
        500,
      );
      const deliveryState = await pool.query(
        "SELECT status, attempt_count, last_http_status FROM delivery_attempts WHERE order_id = $1",
        [orderId],
      );
      assert.deepEqual(deliveryState.rows[0], {
        status: "pending",
        attempt_count: 1,
        last_http_status: 500,
      });
      const saved = await store.getReviewOrder(orderId, accessToken);
      assert.equal(saved.review.status, "completed");
      assert.equal(saved.result.json.order_id, orderId);
      assert.equal(saved.result.json.review?.accessToken, undefined);
      assert.equal(await store.getReviewOrder(orderId, "wrong-token"), null);
    } finally {
      await pool.query("DELETE FROM paid_service_orders WHERE order_id = $1", [orderId]);
      await pool.end();
      await store.closeOrderStore();
    }
  },
);
