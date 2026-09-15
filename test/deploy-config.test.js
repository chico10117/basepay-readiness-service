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

test("Glama Dockerfile uses a production Node runtime and /ping healthcheck", async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile(".dockerignore", "utf8"),
  ]);

  assert.match(dockerfile, /^FROM node:20-bookworm-slim$/m);
  assert.match(dockerfile, /^COPY package\.json package-lock\.json \.\/$/m);
  assert.match(dockerfile, /^RUN npm ci --omit=dev(?: && npm cache clean --force)?$/m);
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  assert.match(dockerfile, /^COPY public \.\/public$/m);
  assert.match(dockerfile, /^EXPOSE 4021$/m);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*127\.0\.0\.1:4021\/ping/);
  assert.match(dockerfile, /^CMD \["npm", "start"\]$/m);
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^node_modules\/$/m);
  assert.match(dockerignore, /^state\/$/m);
});
