import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("API systemd unit exposes review worker health without worker secrets", async () => {
  const service = await readFile("deploy/x402-wallet-readiness.service", "utf8");

  assert.match(service, /^Environment=REVIEW_WORKER_ENABLED=true$/m);
  assert.match(service, /^EnvironmentFile=-\/etc\/x402-wallet-readiness\/runtime\.env$/m);
  assert.match(service, /^EnvironmentFile=-\/etc\/x402-wallet-readiness\/order-store\.env$/m);
  assert.doesNotMatch(service, /review-worker\.env/);
});
