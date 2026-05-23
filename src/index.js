import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";

const PAY_TO =
  process.env.PAY_TO ?? "0xb19262185bac9748e2b71674Ef48676448F7A516";
const PORT = Number(process.env.PORT ?? "4021");
const NETWORK = process.env.X402_NETWORK ?? "eip155:8453";
const PRICE = process.env.X402_PRICE ?? "$2";
const BASE_RPC = process.env.BASE_RPC ?? "https://mainnet.base.org";
const BLOCKSCOUT = process.env.BLOCKSCOUT ?? "https://base.blockscout.com";
const USDC_CONTRACT =
  process.env.USDC_CONTRACT ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://facilitator.world.fun";
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const facilitatorClient =
  process.env.X402_USE_CDP_FACILITATOR === "true"
    ? new HTTPFacilitatorClient(coinbaseFacilitator)
    : new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme(),
);

const app = express();
app.set("trust proxy", true);
if (PUBLIC_URL) {
  app.use((req, _res, next) => {
    req.headers.host = PUBLIC_URL.host;
    req.headers["x-forwarded-proto"] = PUBLIC_URL.protocol.replace(":", "");
    next();
  });
}
app.use(express.json({ limit: "64kb" }));

const serviceInfo = {
  name: "Agent Commerce Desk",
  version: "0.3.0",
  description:
    "Checks whether a Base wallet is safe to publish as a USDC receiving wallet, then sells fixed-price agent payment, VPS, wallet-risk, and QA implementation work.",
  payTo: PAY_TO,
  acceptedPayment: {
    asset: "native USDC",
    assetContract: USDC_CONTRACT,
    network: "Base",
    networkCaip2: NETWORK,
    price: PRICE,
    facilitator: FACILITATOR_URL,
  },
  endpoints: {
    free: [
      "GET /health",
      "GET /manifest",
      "GET /.well-known/agent-card.json",
      "GET /api/800402/preview",
    ],
    paid: [
      "GET /api/readiness?address=0x...",
      "GET /api/readiness/:address",
      "GET /api/agent-commerce-receipt?address=0x...",
      "GET /api/agent-commerce-receipt/:address",
    ],
  },
  input: {
    address: "EVM address on Base, e.g. 0xb19262185bac9748e2b71674Ef48676448F7A516",
  },
  offers: [
    {
      name: "Same-day kickoff",
      priceUsd: 100,
      deliverables: [
        "one scoped blocker",
        "same-day start",
        "public evidence review",
        "next-step patch plan",
      ],
    },
    {
      name: "Base USDC payment setup",
      priceUsd: 150,
      deliverables: [
        "receiving wallet check",
        "x402-ready endpoint",
        "agent-card metadata",
        "deployment notes",
      ],
    },
    {
      name: "VPS health dashboard",
      priceUsd: 200,
      deliverables: ["uptime", "disk", "memory", "service checks", "web status page"],
    },
    {
      name: "Wallet risk monitor",
      priceUsd: 250,
      deliverables: [
        "USDT blacklist checks",
        "wallet activity checks",
        "repeatable report",
      ],
    },
    {
      name: "Agent QA harness",
      priceUsd: 300,
      deliverables: ["test runner", "transcripts", "pass/fail checks", "deployment notes"],
    },
  ],
};

app.get("/health", (_req, res) => {
  res.json({ ok: true, network: NETWORK, payTo: PAY_TO });
});

app.get("/manifest", (_req, res) => {
  res.json(serviceInfo);
});

app.get("/api/800402/preview", (_req, res) => {
  res.json({
    name: serviceInfo.name,
    version: serviceInfo.version,
    description:
      "800402-ready agent commerce demo: ERC-8004-style metadata, x402 payment requirements, and Base USDC receiving-wallet proof in one service.",
    stack: {
      identity: "ERC-8004-style agent metadata",
      payment: "x402 exact scheme",
      settlement: "native USDC on Base mainnet",
      facilitator: FACILITATOR_URL,
    },
    agent: agentIdentity(),
    payment: paymentInfo(),
    endpoints: {
      freePreview:
        `${baseUrl()}/api/preview?address=0xb19262185bac9748e2b71674Ef48676448F7A516`,
      paidReadiness:
        `${baseUrl()}/api/readiness/0xb19262185bac9748e2b71674Ef48676448F7A516`,
      paidCommerceReceipt:
        `${baseUrl()}/api/agent-commerce-receipt/0xb19262185bac9748e2b71674Ef48676448F7A516`,
    },
  });
});

app.get("/api/preview/:address", async (req, res, next) => {
  try {
    const report = await buildReadinessReport(req.params.address);
    res.json(toPreview(report));
  } catch (error) {
    next(error);
  }
});

app.get("/api/preview", async (req, res, next) => {
  try {
    const report = await buildReadinessReport(String(req.query.address ?? ""));
    res.json(toPreview(report));
  } catch (error) {
    next(error);
  }
});

app.get("/.well-known/agent-card.json", (_req, res) => {
  res.json({
    name: serviceInfo.name,
    description: serviceInfo.description,
    url: baseUrl(),
    provider: {
      name: "Codex Agent Wallet Payments Run",
      wallet: PAY_TO,
    },
    capabilities: [
      {
        name: "base_wallet_payment_readiness_check",
        endpoint: "/api/readiness/{address}",
        method: "GET",
        payment: serviceInfo.acceptedPayment,
        endpointUrl:
          "/api/readiness?address=0xb19262185bac9748e2b71674Ef48676448F7A516",
        inputSchema: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          },
        },
      },
      {
        name: "agent_commerce_receipt",
        endpoint: "/api/agent-commerce-receipt/{address}",
        method: "GET",
        payment: serviceInfo.acceptedPayment,
        endpointUrl:
          "/api/agent-commerce-receipt/0xb19262185bac9748e2b71674Ef48676448F7A516",
        inputSchema: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          },
        },
      },
    ],
  });
});

app.get("/.well-known/agent.json", (_req, res) => {
  res.json({
    name: serviceInfo.name,
    description:
      "Fixed-price Base USDC, x402, wallet-readiness, VPS, and agent QA implementation work.",
    url: PUBLIC_URL?.toString() ?? "http://localhost:4021",
    version: serviceInfo.version,
    provider: {
      organization: serviceInfo.name,
      walletAddress: PAY_TO,
    },
    erc8004: agentIdentity(),
    skills: [
      {
        id: "base-wallet-preview",
        name: "Base Wallet Readiness Preview",
        description:
          "Free readiness preview for a Base wallet before publishing it as a USDC receiving address.",
        uri: "/api/preview?address=0x...",
        method: "GET",
      },
      {
        id: "paid-base-wallet-readiness",
        name: "Paid x402 Base Wallet Readiness Report",
        description:
          "Full Base wallet readiness report returned after an x402 USDC payment.",
        uri:
          "/api/readiness?address=0xb19262185bac9748e2b71674Ef48676448F7A516",
        method: "GET",
      },
      {
        id: "paid-agent-commerce-receipt",
        name: "Paid 800402 Agent Commerce Receipt",
        description:
          "Combines agent identity metadata, x402 Base USDC payment terms, and Base wallet-readiness evidence after an x402 payment.",
        uri:
          "/api/agent-commerce-receipt/0xb19262185bac9748e2b71674Ef48676448F7A516",
        method: "GET",
      },
    ],
    payment: paymentInfo(),
    x402: x402Info("/api/readiness/0xb19262185bac9748e2b71674Ef48676448F7A516"),
  });
});

app.use(express.static(PUBLIC_DIR));

app.use(
  paymentMiddleware(
    {
      "GET /api/readiness": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Base wallet payment-readiness check by query parameter. Use ?address=0x...",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            category: "crypto",
            tags: ["base", "wallet", "usdc", "payment-safety", "agent-payments"],
            info: {
              input: {
                method: "GET",
                queryParams: {
                  address: "0xb19262185bac9748e2b71674Ef48676448F7A516",
                },
              },
            },
          },
        },
      },
      "GET /api/readiness/:address": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Base wallet payment-readiness check: ETH balance, native USDC balance, tx count, token transfers, and contract status.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            category: "crypto",
            tags: ["base", "wallet", "usdc", "payment-safety", "agent-payments"],
            info: {
              input: {
                address: "0xb19262185bac9748e2b71674Ef48676448F7A516",
              },
            },
          },
        },
      },
      "GET /api/agent-commerce-receipt": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "800402 agent commerce receipt by query parameter. Use ?address=0x...",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            category: "crypto",
            tags: ["800402", "erc-8004", "x402", "base", "usdc", "agent-commerce"],
            info: {
              input: {
                method: "GET",
                queryParams: {
                  address: "0xb19262185bac9748e2b71674Ef48676448F7A516",
                },
              },
            },
          },
        },
      },
      "GET /api/agent-commerce-receipt/:address": {
        accepts: [
          {
            scheme: "exact",
            price: PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "800402 agent commerce receipt: agent identity metadata, x402 payment terms, and Base wallet-readiness evidence.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            category: "crypto",
            tags: ["800402", "erc-8004", "x402", "base", "usdc", "agent-commerce"],
            info: {
              input: {
                address: "0xb19262185bac9748e2b71674Ef48676448F7A516",
              },
            },
          },
        },
      },
    },
    resourceServer,
  ),
);

app.get("/api/readiness", async (req, res, next) => {
  try {
    res.json(await buildReadinessReport(String(req.query.address ?? "")));
  } catch (error) {
    next(error);
  }
});

app.get("/api/readiness/:address", async (req, res, next) => {
  try {
    res.json(await buildReadinessReport(req.params.address));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-commerce-receipt", async (req, res, next) => {
  try {
    const report = await buildReadinessReport(String(req.query.address ?? ""));
    res.json(buildAgentCommerceReceipt(report));
  } catch (error) {
    next(error);
  }
});

app.get("/api/agent-commerce-receipt/:address", async (req, res, next) => {
  try {
    const report = await buildReadinessReport(req.params.address);
    res.json(buildAgentCommerceReceipt(report));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.statusCode ?? error.status ?? 500;
  res.status(status).json({
    error: error.message ?? "Unexpected server error",
  });
});

app.listen(PORT, () => {
  console.log(
    `Base wallet readiness service listening on http://localhost:${PORT}`,
  );
  console.log(`x402 network=${NETWORK} price=${PRICE} payTo=${PAY_TO}`);
});

function normalizeAddress(address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    const error = new Error("address must be a 20-byte EVM address");
    error.statusCode = 400;
    throw error;
  }
  return address;
}

async function buildReadinessReport(rawAddress) {
  const address = normalizeAddress(rawAddress);
  const [ethBalanceWei, txCount, code, usdcBalanceAtomic, counters, info, tokens] =
    await Promise.all([
      rpc("eth_getBalance", [address, "latest"]),
      rpc("eth_getTransactionCount", [address, "latest"]),
      rpc("eth_getCode", [address, "latest"]),
      usdcBalance(address),
      getJson(`${BLOCKSCOUT}/api/v2/addresses/${address}/counters`),
      getJson(`${BLOCKSCOUT}/api/v2/addresses/${address}`),
      getJson(`${BLOCKSCOUT}/api/v2/addresses/${address}/token-balances`),
    ]);

  const tokenTransfers = Number(counters.token_transfers_count ?? 0);
  const transactions = Number(counters.transactions_count ?? hexToBigInt(txCount));
  const usdc = Number(usdcBalanceAtomic) / 1_000_000;
  const eth = Number(ethBalanceWei) / 1e18;
  const flags = [];

  if (code !== "0x") flags.push("contract_address");
  if (transactions > 0) flags.push("existing_transaction_history");
  if (tokenTransfers > 0) flags.push("existing_token_transfer_history");
  if (usdc > 0) flags.push("existing_native_usdc_balance");
  if (eth > 0) flags.push("existing_eth_balance");

  return {
    address,
    network: "base",
    chainId: 8453,
    timestamp: new Date().toISOString(),
    balances: {
      eth,
      nativeUsdc: usdc,
    },
    activity: {
      transactionCount: transactions,
      gasUsageCount: Number(counters.gas_usage_count ?? 0),
      tokenTransferCount: tokenTransfers,
      validationsCount: Number(counters.validations_count ?? 0),
    },
    status: {
      isContract: code !== "0x",
      blockscoutReputation: info.reputation ?? "unknown",
      hasTokens: Boolean(info.has_tokens),
      visibleTokenBalances: Array.isArray(tokens) ? tokens.length : 0,
      flags,
      readiness:
        flags.length === 0
          ? "clean_new_receiving_wallet"
          : "review_before_publishing",
    },
    payment: {
      recommendedAsset: "native USDC",
      recommendedNetwork: "Base",
      nativeUsdcContract: USDC_CONTRACT,
    },
  };
}

function toPreview(report) {
  return {
    address: report.address,
    network: report.network,
    timestamp: report.timestamp,
    status: report.status,
    activity: report.activity,
    payment: report.payment,
    paidEndpoint: `/api/readiness?address=${report.address}`,
    note: "Preview is free. The paid x402 endpoint returns the full balance report.",
  };
}

function buildAgentCommerceReceipt(report) {
  return {
    receiptType: "800402-agent-commerce-readiness",
    generatedAt: new Date().toISOString(),
    agent: agentIdentity(),
    payment: paymentInfo(),
    x402: x402Info(`/api/agent-commerce-receipt/${report.address}`),
    subject: {
      wallet: report.address,
      network: "Base",
      chainId: 8453,
    },
    readinessReport: report,
    proof: {
      metadataUrl: `${baseUrl()}/.well-known/agent.json`,
      agentCardUrl: `${baseUrl()}/.well-known/agent-card.json`,
      freePreviewUrl: `${baseUrl()}/api/preview/${report.address}`,
      protectedReceiptUrl: `${baseUrl()}/api/agent-commerce-receipt/${report.address}`,
      verifierChecklist: [
        "HTTP 402 challenge returns Base mainnet x402 payment requirements",
        "payTo matches the published receiving wallet",
        "asset contract matches native USDC on Base",
        "wallet-readiness report was generated from Base RPC and Blockscout",
      ],
    },
  };
}

function agentIdentity() {
  return {
    standard: "erc-8004-ready",
    status: "metadata_published",
    name: serviceInfo.name,
    agentWallet: PAY_TO,
    agentUri: `${baseUrl()}/.well-known/agent.json`,
    agentCardUri: `${baseUrl()}/.well-known/agent-card.json`,
    services: [
      {
        name: "Base wallet readiness",
        transport: "https",
        payment: "x402",
        endpoint: `${baseUrl()}/api/readiness/0xb19262185bac9748e2b71674Ef48676448F7A516`,
      },
      {
        name: "800402 agent commerce receipt",
        transport: "https",
        payment: "x402",
        endpoint: `${baseUrl()}/api/agent-commerce-receipt/0xb19262185bac9748e2b71674Ef48676448F7A516`,
      },
    ],
    supportedTrust: ["erc-8004", "x402", "base-usdc"],
  };
}

function paymentInfo() {
  return {
    asset: "native USDC",
    assetContract: USDC_CONTRACT,
    network: "Base",
    networkCaip2: NETWORK,
    facilitator: FACILITATOR_URL,
    payTo: PAY_TO,
    priceUsd: priceUsd(),
  };
}

function x402Info(path) {
  return {
    endpoint: `${baseUrl()}${path}`,
    method: "GET",
    priceUsd: priceUsd(),
    asset: USDC_CONTRACT,
    network: NETWORK,
    facilitator: FACILITATOR_URL,
    payTo: PAY_TO,
  };
}

function baseUrl() {
  return (PUBLIC_URL?.toString() ?? "http://localhost:4021").replace(/\/$/, "");
}

function priceUsd() {
  return Number(PRICE.replace(/^\$/, ""));
}

async function rpc(method, params) {
  const response = await fetch(BASE_RPC, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "codex-agent-wallet-readiness/0.1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Base RPC request failed: ${response.status}`);
  }
  const body = await response.json();
  if (body.error) {
    throw new Error(body.error.message ?? JSON.stringify(body.error));
  }
  return body.result;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "codex-agent-wallet-readiness/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`Blockscout request failed: ${response.status}`);
  }
  return response.json();
}

async function usdcBalance(address) {
  const encodedAddress = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const data = `0x70a08231${encodedAddress}`;
  return hexToBigInt(
    await rpc("eth_call", [{ to: USDC_CONTRACT, data }, "latest"]),
  );
}

function hexToBigInt(value) {
  if (!value || value === "0x") return 0n;
  return BigInt(value);
}
