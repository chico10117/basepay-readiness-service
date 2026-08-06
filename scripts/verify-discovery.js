import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import {
  buildAgentMetadata,
  buildLlmsTxt,
  buildOpenApiDocument,
  buildPublicManifest,
  buildX402Manifest,
} from "../src/preflight/discovery.js";
import { parseX402Challenge } from "../src/preflight/challenge.js";

const expectedTools = [
  "inspect_x402_endpoint",
  "audit_x402_endpoint",
  "order_x402_remediation",
];
const config = configFromEnvironment();
const local = verifyLocalContracts(config);
const output = {
  ok: true,
  mode: process.env.PUBLIC_URL ? "local_and_public" : "local_contract",
  local,
  public: null,
};

if (process.env.PUBLIC_URL) {
  output.public = await verifyPublicContracts(config);
}

console.log(JSON.stringify(output, null, 2));

function verifyLocalContracts(config) {
  const manifest = buildPublicManifest(config);
  const openapi = buildOpenApiDocument(config);
  const llms = buildLlmsTxt(config);
  const agent = buildAgentMetadata(config);
  const x402 = buildX402Manifest(config);
  assertNames("manifest", manifest.capabilities.map(item => item.name));
  assertNames("agent metadata", agent.capabilities.map(item => item.name));
  assertNames(
    "OpenAPI",
    Object.values(openapi.paths).map(path => path.post.operationId),
  );
  for (const name of expectedTools) {
    if (!llms.includes(name)) throw new Error(`llms.txt is missing ${name}`);
  }
  if (x402.resources.length !== 2) {
    throw new Error("x402 metadata must contain the two paid canonical resources");
  }
  for (const schemaName of [
    "PreflightInput",
    "PreflightReport",
    "RemediationInput",
    "RemediationReceipt",
    "ErrorEnvelope",
  ]) {
    if (openapi.components.schemas[schemaName]?.additionalProperties !== false) {
      throw new Error(`${schemaName} must reject additional properties`);
    }
  }
  return {
    manifest: true,
    openapi: true,
    llmsTxt: true,
    agentMetadata: true,
    x402Metadata: true,
    canonicalCapabilities: expectedTools,
  };
}

async function verifyPublicContracts(config) {
  const [manifestResponse, openapiResponse, llmsResponse, agentResponse, x402Response] =
    await Promise.all([
      get("/manifest"),
      get("/openapi.json"),
      get("/llms.txt"),
      get("/.well-known/agent.json"),
      get("/.well-known/x402.json"),
    ]);
  for (const response of [
    manifestResponse,
    openapiResponse,
    llmsResponse,
    agentResponse,
    x402Response,
  ]) {
    if (!response.ok) throw new Error(`${response.url} returned HTTP ${response.status}`);
  }
  const manifest = await manifestResponse.json();
  const openapi = await openapiResponse.json();
  const llms = await llmsResponse.text();
  const agent = await agentResponse.json();
  const x402 = await x402Response.json();
  assertNames("public manifest", manifest.capabilities.map(item => item.name));
  assertNames("public agent metadata", agent.capabilities.map(item => item.name));
  assertNames(
    "public OpenAPI",
    Object.values(openapi.paths).map(path => path.post.operationId),
  );
  for (const name of expectedTools) {
    if (!llms.includes(name)) throw new Error(`public llms.txt is missing ${name}`);
  }
  if (x402.resources.length !== 2) throw new Error("public x402 metadata is inconsistent");

  const audit = await fetchWithTimeout(new URL("/api/x402/preflight/audit", config.baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      resource_url: new URL("/api/x402/preflight/audit", config.baseUrl),
      method: "POST",
      expected_network: config.network,
      max_price_usd: 1,
    }),
  });
  if (audit.status !== 402) throw new Error(`public audit returned HTTP ${audit.status}`);
  const challenge = parseX402Challenge(audit.headers, await audit.text(), {
    usdcContract: config.asset,
  });
  const expectedAmount = String(Math.round(priceNumber(config.auditPrice) * 1_000_000));
  const comparisons = {
    network: [challenge.payment.network, config.network],
    asset: [challenge.payment.asset?.toLowerCase(), config.asset.toLowerCase()],
    amount: [challenge.payment.amountAtomic, expectedAmount],
    payTo: [challenge.payment.payTo?.toLowerCase(), config.payTo.toLowerCase()],
  };
  for (const [field, [actual, expected]] of Object.entries(comparisons)) {
    if (actual !== expected) {
      throw new Error(`public ${field} mismatch: ${actual} != ${expected}`);
    }
  }
  if (!challenge.payment.bazaar.found || challenge.payment.bazaar.valid !== true) {
    throw new Error("public audit challenge has invalid Bazaar metadata");
  }
  return {
    manifest: true,
    openapi: true,
    llmsTxt: true,
    agentMetadata: true,
    x402Metadata: true,
    challenge402: true,
    bazaar: true,
  };

  function get(path) {
    return fetchWithTimeout(new URL(path, config.baseUrl), {
      headers: { accept: path.endsWith(".txt") ? "text/plain" : "application/json" },
      redirect: "manual",
    });
  }
}

function configFromEnvironment() {
  const useCdp = process.env.X402_USE_CDP_FACILITATOR === "true";
  return {
    technicalName: "x402-preflight",
    baseUrl: String(process.env.PUBLIC_URL ?? "http://localhost:4021").replace(/\/$/, ""),
    version: process.env.SERVICE_VERSION ?? "1.0.0",
    network: process.env.X402_NETWORK ?? "eip155:8453",
    asset:
      process.env.USDC_CONTRACT ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo:
      process.env.PAY_TO ?? "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9",
    facilitator: useCdp
      ? coinbaseFacilitator.url
      : process.env.X402_FACILITATOR_URL ?? "https://facilitator.world.fun",
    auditPrice: process.env.PREFLIGHT_AUDIT_X402_PRICE ?? "$0.05",
    remediationPrice:
      process.env.REMEDIATION_X402_PRICE ??
      process.env.INTEGRATION_TRIAGE_X402_PRICE ??
      "$100",
  };
}

function assertNames(label, names) {
  if (JSON.stringify(names) !== JSON.stringify(expectedTools)) {
    throw new Error(`${label} capabilities differ: ${JSON.stringify(names)}`);
  }
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function priceNumber(value) {
  return Number(String(value).replace(/^\$/, ""));
}
