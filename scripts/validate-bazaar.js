import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  auditHttpDiscoveryExtension,
  auditMcpDiscoveryExtension,
  remediationHttpDiscoveryExtension,
  remediationMcpDiscoveryExtension,
} from "../src/preflight/discovery.js";
import { parseX402Challenge } from "../src/preflight/challenge.js";

const config = discoveryConfig();
const declarations = {
  audit_http: auditHttpDiscoveryExtension(config),
  audit_mcp: auditMcpDiscoveryExtension(config),
  remediation_http: remediationHttpDiscoveryExtension(config),
  remediation_mcp: remediationMcpDiscoveryExtension(config),
};
const results = {};

for (const [name, declaration] of Object.entries(declarations)) {
  const validation = validateDiscoveryExtension(declaration.bazaar);
  results[name] = validation;
  if (!validation.valid) {
    throw new Error(`${name} Bazaar metadata is invalid: ${JSON.stringify(validation)}`);
  }
}

const output = {
  ok: true,
  mode: process.env.PUBLIC_URL ? "local_and_public_challenge" : "local_schema",
  facilitatorMode: process.env.X402_USE_CDP_FACILITATOR === "true" ? "cdp" : "custom",
  declarations: results,
  publicChallenge: null,
  cdpCatalog: null,
  note:
    "Bazaar catalog presence still requires a successful settlement through the CDP Facilitator; this command never pays.",
};

if (process.env.PUBLIC_URL) {
  const response = await fetchWithTimeout(
    new URL("/api/x402/preflight/audit", config.baseUrl),
    {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        resource_url: new URL("/api/x402/preflight/audit", config.baseUrl),
        method: "POST",
        expected_network: config.network,
        max_price_usd: 1,
      }),
    },
  );
  if (response.status !== 402) {
    throw new Error(`public audit route returned HTTP ${response.status}, expected 402`);
  }
  const body = await response.text();
  const challenge = parseX402Challenge(response.headers, body, {
    usdcContract: config.asset,
  });
  if (!challenge.payment.detected || challenge.payment.bazaar.valid !== true) {
    throw new Error("public audit challenge does not contain valid Bazaar metadata");
  }
  output.publicChallenge = {
    statusCode: response.status,
    version: challenge.payment.x402Version,
    network: challenge.payment.network,
    amountAtomic: challenge.payment.amountAtomic,
    bazaarValid: challenge.payment.bazaar.valid,
  };
  output.cdpCatalog = await inspectCdpCatalog(config);
}

console.log(JSON.stringify(output, null, 2));

function discoveryConfig() {
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

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function inspectCdpCatalog(config) {
  const url = new URL(
    "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant",
  );
  url.searchParams.set("payTo", config.payTo);
  url.searchParams.set("limit", "100");
  const response = await fetchWithTimeout(url, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    return { checked: true, statusCode: 404, indexed: false, matchingResources: 0 };
  }
  if (!response.ok) {
    throw new Error(`CDP Bazaar merchant lookup returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  const expected = new URL("/api/x402/preflight/audit", config.baseUrl);
  const matches = (Array.isArray(payload.resources) ? payload.resources : []).filter(item => {
    try {
      const resource = new URL(item.resource);
      return resource.origin === expected.origin && resource.pathname === expected.pathname;
    } catch {
      return false;
    }
  });
  return {
    checked: true,
    statusCode: response.status,
    indexed: matches.length > 0,
    matchingResources: matches.length,
  };
}
