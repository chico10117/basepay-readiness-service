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

test("public inspector exposes the paid audit handoff URL generator", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /id="paid-handoff-title"/);
  assert.match(html, /id="paid-audit-url"/);
  assert.match(html, /id="paid-audit-link"/);
  assert.match(html, /id="copy-paid-audit"/);
  assert.match(html, /id="quick-review-url"/);
  assert.match(html, /id="quick-review-link"/);
  assert.match(html, /id="integration-triage-url"/);
  assert.match(html, /id="integration-triage-link"/);
  assert.match(html, /POST \/api\/x402\/preflight\/audit/);
  assert.match(html, /\$50 x402/);
  assert.match(html, /\$100 x402/);
  assert.match(app, /defaultResourceUrl = "https:\/\/example\.com\/api\/resource"/);
  assert.match(app, /resourceUrlInput\?\.value\?\.trim\(\) \|\| defaultResourceUrl/);
  assert.match(app, /new URL\("\/api\/x402\/preflight\/audit", window\.location\.origin\)/);
  assert.match(app, /new URL\(path, window\.location\.origin\)/);
  assert.match(app, /searchParams\.set\("repository_or_url"/);
  assert.match(app, /searchParams\.set\("goal"/);
  assert.match(app, /searchParams\.set\("resource_url"/);
  assert.match(app, /\["GET", "HEAD"\]\.includes\(method\)/);
});
