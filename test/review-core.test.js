import assert from "node:assert/strict";
import test from "node:test";

import {
  createWebhookSignature,
  validateCallbackUrl,
  verifyWebhookSignature,
} from "../src/review/delivery.js";
import { runReviewAgent } from "../src/review/agent-runner.js";
import { renderReviewMarkdown } from "../src/review/markdown-renderer.js";
import { validateReviewResult } from "../src/review/result-schema.js";
import {
  assertPublicUrl,
  normalizeReviewTarget,
} from "../src/review/target-policy.js";

test("normalizes public GitHub targets and callback URLs", () => {
  assert.deepEqual(normalizeReviewTarget("vercel/next.js"), {
    kind: "github_repo",
    owner: "vercel",
    repo: "next.js",
    url: "https://github.com/vercel/next.js",
  });
  assert.equal(
    validateCallbackUrl("https://buyer.example/callback"),
    "https://buyer.example/callback",
  );
  assert.throws(() => validateCallbackUrl("http://buyer.example/callback"), /HTTPS/);
  assert.throws(() => validateCallbackUrl("https://127.0.0.1/callback"), /private|loopback/i);
});

test("blocks private target addresses before any request", async () => {
  await assert.rejects(
    () => assertPublicUrl("http://127.0.0.1/secret"),
    /private|loopback/i,
  );
  await assert.rejects(
    () => assertPublicUrl("http://localhost/secret"),
    /local|loopback/i,
  );
});

test("webhook signatures are verifiable and tamper resistant", () => {
  const timestamp = "1785970000";
  const body = JSON.stringify({ event: "x402.order.completed", order_id: "test" });
  const signature = createWebhookSignature("test-secret", timestamp, body);
  assert.equal(verifyWebhookSignature("test-secret", timestamp, body, `sha256=${signature}`), true);
  assert.equal(verifyWebhookSignature("test-secret", timestamp, `${body}x`, signature), false);
});

test("deterministic endpoint reviewer emits a validated result and report", async () => {
  const { result, metadata } = await runReviewAgent({
    job: {
      order_id: "test-order",
      service: "Base USDC x402 Quick Review",
      goal: "Review the x402 payment endpoint",
    },
    targetSnapshot: {
      type: "https_endpoint",
      url: "https://example.com/api",
      retrieved_at: new Date().toISOString(),
    },
    evidence: {
      type: "https_endpoint",
      url: "https://example.com/api",
      probes: [
        {
          method: "GET",
          status: 402,
          ok: false,
          duration_ms: 40,
          challenge: { raw: "{\"network\":\"eip155:8453\"}" },
          body_snippet: "",
        },
        {
          method: "OPTIONS",
          status: 204,
          ok: true,
          duration_ms: 20,
          challenge: null,
          body_snippet: "",
        },
      ],
    },
  });

  assert.equal(metadata.provider, "deterministic");
  assert.equal(result.schema_version, "x402-review-result/v1");
  assert.equal(result.order_id, "test-order");
  validateReviewResult(result);
  const markdown = renderReviewMarkdown(result);
  assert.match(markdown, /Base USDC x402 Quick Review/);
  assert.match(markdown, /## Checks/);
});
