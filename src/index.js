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
const NETWORK = process.env.X402_NETWORK ?? "eip155:84532";
const PRICE = process.env.X402_PRICE ?? "$2";
const BASE_RPC = process.env.BASE_RPC ?? "https://mainnet.base.org";
const BLOCKSCOUT = process.env.BLOCKSCOUT ?? "https://base.blockscout.com";
const USDC_CONTRACT =
  process.env.USDC_CONTRACT ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const isMainnet = NETWORK === "eip155:8453";
const facilitatorClient =
  process.env.X402_USE_CDP_FACILITATOR === "true" || isMainnet
    ? new HTTPFacilitatorClient(coinbaseFacilitator)
    : new HTTPFacilitatorClient({
        url: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
      });

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
app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "64kb" }));

const serviceInfo = {
  name: "Agent Commerce Desk",
  version: "0.1.0",
  description:
    "Fixed-price crypto, agent, and VPS automation work with a live x402 wallet-readiness endpoint as proof.",
  payTo: PAY_TO,
  acceptedPayment: {
    asset: "native USDC",
    network: NETWORK,
    price: PRICE,
  },
  endpoints: {
    free: ["GET /health", "GET /manifest", "GET /.well-known/agent-card.json"],
    paid: ["GET /api/readiness?address=0x...", "GET /api/readiness/:address"],
  },
  input: {
    address: "EVM address on Base, e.g. 0xb19262185bac9748e2b71674Ef48676448F7A516",
  },
  offers: [
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
    url: PUBLIC_URL?.toString() ?? "http://localhost:4021",
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
    ],
  });
});

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
