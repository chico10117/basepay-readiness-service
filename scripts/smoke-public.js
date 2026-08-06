import { parseX402Challenge } from "../src/preflight/challenge.js";

const publicUrl = String(process.env.PUBLIC_URL ?? "").trim().replace(/\/$/, "");
if (!publicUrl) throw new Error("PUBLIC_URL is required for smoke:public");
const expectedVersion = process.env.SERVICE_VERSION ?? "1.0.0";
const expectedCommit = process.env.GIT_COMMIT_SHA ?? "unknown";
const network = process.env.X402_NETWORK ?? "eip155:8453";
const asset =
  process.env.USDC_CONTRACT ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const healthResponse = await request("/health", { headers: { accept: "application/json" } });
assertOk(healthResponse, "health");
const health = await healthResponse.json();
if (health.version !== expectedVersion) {
  throw new Error(`health version ${health.version} does not match ${expectedVersion}`);
}
if (expectedCommit !== "unknown" && health.commitSha !== expectedCommit) {
  throw new Error(`health commit ${health.commitSha} does not match ${expectedCommit}`);
}
for (const header of ["x-service-version", "x-commit-sha", "x-request-id"]) {
  if (!healthResponse.headers.get(header)) throw new Error(`/health is missing ${header}`);
}

for (const path of ["/manifest", "/openapi.json", "/llms.txt"]) {
  const response = await request(path, { headers: { accept: "*/*" } });
  assertOk(response, path);
}

const inspectTarget =
  process.env.SMOKE_INSPECT_TARGET_URL ??
  new URL("/api/x402/market/crypto-snapshot?limit=1", publicUrl).toString();
const input = {
  resource_url: inspectTarget,
  method: "GET",
  expected_network: network,
  max_price_usd: 1,
};
const inspect = await request("/api/preflight/inspect", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(input),
});
assertOk(inspect, "free inspect");
const report = await inspect.json();
if (report.resource.statusCode !== 402) {
  throw new Error(`free inspect observed HTTP ${report.resource.statusCode}, expected 402`);
}

const audit = await request("/api/x402/preflight/audit", {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(input),
});
if (audit.status !== 402) throw new Error(`audit returned HTTP ${audit.status}, expected 402`);
if (!/no-store|private/i.test(audit.headers.get("cache-control") ?? "")) {
  throw new Error("audit challenge is missing private/no-store cache control");
}
const challenge = parseX402Challenge(audit.headers, await audit.text(), {
  usdcContract: asset,
});
if (!challenge.payment.detected || challenge.payment.network !== network) {
  throw new Error("audit returned an invalid or inconsistent payment challenge");
}

const cors = await request("/api/x402/preflight/audit", {
  method: "OPTIONS",
  headers: {
    origin: "https://agent.example",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type,payment-signature",
  },
});
if (cors.status !== 204) throw new Error(`audit OPTIONS returned HTTP ${cors.status}`);
if (!/payment-signature/i.test(cors.headers.get("access-control-allow-headers") ?? "")) {
  throw new Error("audit CORS does not allow payment-signature");
}
if (!/payment-required|payment-response/i.test(
  cors.headers.get("access-control-expose-headers") ?? "",
)) {
  throw new Error("audit CORS does not expose x402 response headers");
}

console.log(JSON.stringify({
  ok: true,
  publicUrl,
  version: health.version,
  commitSha: health.commitSha,
  inspectDecision: report.decision,
  challenge: {
    version: challenge.payment.x402Version,
    network: challenge.payment.network,
    priceUsd: challenge.payment.priceUsd,
    bazaar: challenge.payment.bazaar.valid,
  },
}, null, 2));

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(new URL(path, publicUrl), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(response, name) {
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
}
