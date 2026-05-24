import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import { calculateSplit } from "@pyrimid/sdk/middleware";
import { PyrimidResolver } from "@pyrimid/sdk/resolver";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

const PAY_TO =
  process.env.PAY_TO ?? "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9";
const SAMPLE_ADDRESS = process.env.SAMPLE_ADDRESS ?? PAY_TO;
const PORT = Number(process.env.PORT ?? "4021");
const NETWORK = process.env.X402_NETWORK ?? "eip155:8453";
const PRICE = process.env.X402_PRICE ?? "$2";
const MARKET_SNAPSHOT_X402_PRICE =
  process.env.MARKET_SNAPSHOT_X402_PRICE ?? "$0.01";
const MARKET_OHLCV_X402_PRICE =
  process.env.MARKET_OHLCV_X402_PRICE ?? "$0.02";
const DEV_REPO_SNAPSHOT_X402_PRICE =
  process.env.DEV_REPO_SNAPSHOT_X402_PRICE ?? "$0.05";
const WEATHER_CURRENT_X402_PRICE =
  process.env.WEATHER_CURRENT_X402_PRICE ?? "$0.01";
const BASE_RPC = process.env.BASE_RPC ?? "https://mainnet.base.org";
const COINBASE_EXCHANGE_API =
  process.env.COINBASE_EXCHANGE_API ?? "https://api.exchange.coinbase.com";
const COINGECKO_API = process.env.COINGECKO_API ?? "https://api.coingecko.com";
const OPEN_METEO_API =
  process.env.OPEN_METEO_API ?? "https://api.open-meteo.com";
const GITHUB_API = process.env.GITHUB_API ?? "https://api.github.com";
const GITHUB_PUBLIC_API_TOKEN = process.env.GITHUB_PUBLIC_API_TOKEN ?? "";
const BLOCKSCOUT = process.env.BLOCKSCOUT ?? "https://base.blockscout.com";
const USDC_CONTRACT =
  process.env.USDC_CONTRACT ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MARKET_FEED_API_KEY = process.env.MARKET_FEED_API_KEY ?? "";
const MARKET_CACHE_TTL_SECONDS = Number(process.env.MARKET_CACHE_TTL_SECONDS ?? "900");
const MARKET_SNAPSHOT_CACHE_TTL_SECONDS = Number(
  process.env.MARKET_SNAPSHOT_CACHE_TTL_SECONDS ?? "60",
);
const DEV_REPO_CACHE_TTL_SECONDS = Number(
  process.env.DEV_REPO_CACHE_TTL_SECONDS ?? "300",
);
const THE402_API_KEY = process.env.THE402_API_KEY ?? "";
const THE402_WEBHOOK_SECRET = process.env.THE402_WEBHOOK_SECRET ?? "";
const THE402_WEBHOOK_TOLERANCE_SECONDS = Number(
  process.env.THE402_WEBHOOK_TOLERANCE_SECONDS ?? "300",
);
const PYRIMID_AFFILIATE_ID =
  process.env.PYRIMID_AFFILIATE_ID ?? "agent-commerce-desk";
const PYRIMID_CATALOG_URL =
  process.env.PYRIMID_CATALOG_URL ?? "https://pyrimid.ai/api/v1/catalog";
const PYRIMID_DEFAULT_MAX_PRICE_ATOMIC = Number(
  process.env.PYRIMID_DEFAULT_MAX_PRICE_ATOMIC ?? "1000000",
);
const FOUR_O_TWO_INDEX_VERIFICATION_HASH =
  process.env.FOUR_O_TWO_INDEX_VERIFICATION_HASH ??
  "1505afd8aa35f67c6e036f5b95a276890559851fc9742b2a242d2b3197a109e8";
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://facilitator.world.fun";
const USE_CDP_FACILITATOR = process.env.X402_USE_CDP_FACILITATOR === "true";
const ACTIVE_FACILITATOR_URL = USE_CDP_FACILITATOR
  ? coinbaseFacilitator.url
  : FACILITATOR_URL;
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MARKET_ALLOWED_PAIRS = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);
const MARKET_CACHE = new Map();

const facilitatorClient =
  USE_CDP_FACILITATOR
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
app.use(
  express.json({
    limit: "64kb",
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }),
);

const serviceInfo = {
  name: "Agent Commerce Desk",
  version: "0.9.0",
  description:
    "Checks Base wallets for USDC receiving readiness, publishes paid x402 data APIs, and sells fixed-price agent payment, developer-tool, VPS, wallet-risk, and QA implementation work.",
  payTo: PAY_TO,
  acceptedPayment: {
    asset: "native USDC",
    assetContract: USDC_CONTRACT,
    network: "Base",
    networkCaip2: NETWORK,
    price: PRICE,
    payTo: PAY_TO,
    facilitator: ACTIVE_FACILITATOR_URL,
  },
  endpoints: {
    free: [
      "GET /health",
      "GET /manifest",
      "GET /.well-known/agent-card.json",
      "GET /.well-known/x402",
      "GET /.well-known/x402.json",
      "GET /llms.txt",
      "GET /api/800402/preview",
      "GET /api/preview?address=0x...",
      "GET /api/preview/:address",
      "POST /api/preview",
      "POST /api/preview/:address",
      "GET /api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365",
      "GET /api/market/crypto-snapshot?limit=50",
      "POST /api/market/ohlcv",
      "POST /api/market/crypto-snapshot",
      "GET /api/dev/repo-snapshot?repo=owner/name",
      "POST /api/dev/repo-snapshot",
      "GET /api/weather/current?latitude=37.7749&longitude=-122.4194",
      "GET /api/pyrimid/recommend?need=paid%20mcp%20tool",
      "POST /api/pyrimid/recommend",
      "GET /.well-known/the402.json",
      "GET /api/the402/services",
      "GET /api/the402/webhook",
      "POST /api/the402/webhook",
      "GET /wallet-sign",
    ],
    paid: [
      "GET /api/readiness?address=0x...",
      "GET /api/readiness/:address",
      "GET /api/agent-commerce-receipt?address=0x...",
      "GET /api/agent-commerce-receipt/:address",
      "GET /api/x402/market/crypto-snapshot?limit=50",
      "GET /api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365",
      "GET /api/x402/dev/repo-snapshot?repo=owner/name",
      "GET /api/x402/weather/current?latitude=37.7749&longitude=-122.4194",
    ],
  },
  input: {
    address: `EVM address on Base, e.g. ${SAMPLE_ADDRESS}`,
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
    {
      name: "Daily BTC/ETH OHLCV market data feed",
      priceUsd: 100,
      deliverables: [
        "REST JSON endpoint",
        "365 days of BTC/USD and ETH/USD daily candles",
        "API-key option",
        "cache and uptime notes",
      ],
    },
    {
      name: "Top-50 crypto price snapshot feed",
      priceUsd: 150,
      deliverables: [
        "REST JSON endpoint",
        "top 50 crypto assets by market cap",
        "price, volume, market cap, and Coinbase bid/ask where available",
        "60-second cache and API-key option",
      ],
    },
    {
      name: "GitHub repo intelligence snapshot",
      priceUsd: 75,
      deliverables: [
        "repo metadata and activity summary",
        "language and dependency signals",
        "recent commit and release context",
        "machine-readable scoping notes",
      ],
    },
  ],
  tools: {
    walletSignatureHelper: "/wallet-sign",
    repoSnapshot: "/api/dev/repo-snapshot",
    pyrimidRecommendations: "/api/pyrimid/recommend",
    the402Services: "/api/the402/services",
    the402Webhook: "/api/the402/webhook",
  },
  pyrimid: {
    integrationPath: "embedded_resolver",
    sdk: "@pyrimid/sdk",
    affiliateId: PYRIMID_AFFILIATE_ID,
    catalogUrl: PYRIMID_CATALOG_URL,
    payoutWallet: PAY_TO,
  },
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
      facilitator: ACTIVE_FACILITATOR_URL,
    },
    agent: agentIdentity(),
    payment: paymentInfo(),
    endpoints: {
      freePreview:
        `${baseUrl()}/api/preview?address=${SAMPLE_ADDRESS}`,
      paidReadiness:
        `${baseUrl()}/api/readiness/${SAMPLE_ADDRESS}`,
      paidCommerceReceipt:
        `${baseUrl()}/api/agent-commerce-receipt/${SAMPLE_ADDRESS}`,
    },
  });
});

app.get("/api/market/ohlcv", async (req, res, next) => {
  try {
    requireMarketApiKey(req);
    res.json(await buildMarketOhlcvFeed(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/market/ohlcv", async (req, res, next) => {
  try {
    requireMarketApiKey(req);
    res.json(await buildMarketOhlcvFeed(bodyToQuery(req.body)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/market/crypto-snapshot", async (req, res, next) => {
  try {
    requireMarketApiKey(req);
    res.json(await buildCryptoSnapshotFeed(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/market/crypto-snapshot", async (req, res, next) => {
  try {
    requireMarketApiKey(req);
    res.json(await buildCryptoSnapshotFeed(bodyToQuery(req.body)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/dev/repo-snapshot", async (req, res, next) => {
  try {
    res.json(await buildRepoSnapshot(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/dev/repo-snapshot", async (req, res, next) => {
  try {
    res.json(await buildRepoSnapshot(bodyToQuery(req.body)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/weather/current", async (req, res, next) => {
  try {
    res.json(await buildWeatherCurrent(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/weather/current", async (req, res, next) => {
  try {
    res.json(await buildWeatherCurrent(bodyToQuery(req.body)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/pyrimid/recommend", async (req, res, next) => {
  try {
    res.json(await buildPyrimidRecommendations(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/pyrimid/recommend", async (req, res, next) => {
  try {
    res.json(await buildPyrimidRecommendations(bodyToQuery(req.body)));
  } catch (error) {
    next(error);
  }
});

app.get("/.well-known/the402.json", (_req, res) => {
  res.json(the402Manifest());
});

app.get("/api/the402/services", (_req, res) => {
  res.json(the402Manifest());
});

app.get("/api/the402/webhook", (_req, res) => {
  res.json({
    ok: true,
    service: serviceInfo.name,
    endpoint: `${baseUrl()}/api/the402/webhook`,
    expectedSignature: THE402_WEBHOOK_SECRET
      ? "X-Webhook-Signature HMAC-SHA256"
      : "not configured yet",
    events: ["job_dispatch", "thread_inquiry", "quote_request", "webhook_test"],
    instantServices: the402ServiceDefinitions()
      .filter((service) => service.fulfillment_type === "instant")
      .map((service) => service.name),
  });
});

app.post("/api/the402/webhook", async (req, res, next) => {
  try {
    res.json(await handleThe402Webhook(req));
  } catch (error) {
    next(error);
  }
});

app.get("/api/preview/:address", previewReadiness);
app.post("/api/preview/:address", previewReadiness);
app.get("/api/preview", previewReadiness);
app.post("/api/preview", previewReadiness);

async function previewReadiness(req, res, next) {
  try {
    const report = await buildReadinessReport(previewAddress(req));
    res.json(toPreview(report));
  } catch (error) {
    next(error);
  }
}

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
          `/api/readiness?address=${SAMPLE_ADDRESS}`,
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
          `/api/agent-commerce-receipt/${SAMPLE_ADDRESS}`,
        inputSchema: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
          },
        },
      },
      {
        name: "daily_crypto_ohlcv_feed",
        endpoint: "/api/market/ohlcv",
        method: "GET",
        payment: {
          mode: MARKET_FEED_API_KEY ? "api_key" : "demo_unlocked",
          settlement: "USDC on Base by service agreement",
          payTo: PAY_TO,
        },
        endpointUrl: "/api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365",
        inputSchema: {
          type: "object",
          properties: {
            pairs: {
              type: "string",
              example: "BTC-USD,ETH-USD",
            },
            days: {
              type: "integer",
              minimum: 1,
              maximum: 365,
            },
          },
        },
      },
      {
        name: "top_crypto_price_snapshot_feed",
        endpoint: "/api/market/crypto-snapshot",
        method: "GET",
        payment: {
          mode: MARKET_FEED_API_KEY ? "api_key" : "demo_unlocked",
          settlement: "USDC on Base by service agreement",
          payTo: PAY_TO,
        },
        endpointUrl: "/api/market/crypto-snapshot?limit=50",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
            },
          },
        },
      },
      {
        name: "paid_top_crypto_price_snapshot_feed",
        endpoint: "/api/x402/market/crypto-snapshot",
        method: "GET",
        payment: x402Info(
          "/api/x402/market/crypto-snapshot?limit=50",
          MARKET_SNAPSHOT_X402_PRICE,
        ),
        endpointUrl: "/api/x402/market/crypto-snapshot?limit=50",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 50,
            },
          },
        },
      },
      {
        name: "paid_daily_crypto_ohlcv_feed",
        endpoint: "/api/x402/market/ohlcv",
        method: "GET",
        payment: x402Info(
          "/api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365",
          MARKET_OHLCV_X402_PRICE,
        ),
        endpointUrl: "/api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365",
        inputSchema: {
          type: "object",
          properties: {
            pairs: {
              type: "string",
              example: "BTC-USD,ETH-USD",
            },
            days: {
              type: "integer",
              minimum: 1,
              maximum: 365,
            },
          },
        },
      },
      {
        name: "github_repo_intelligence_snapshot",
        endpoint: "/api/dev/repo-snapshot",
        method: "GET",
        payment: {
          mode: "free_preview",
          settlement: "paid x402 endpoint or service agreement for repeated use",
          payTo: PAY_TO,
        },
        endpointUrl: "/api/dev/repo-snapshot?repo=vercel/next.js",
        inputSchema: {
          type: "object",
          required: ["repo"],
          properties: {
            repo: {
              type: "string",
              pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
              example: "vercel/next.js",
            },
          },
        },
      },
      {
        name: "paid_github_repo_intelligence_snapshot",
        endpoint: "/api/x402/dev/repo-snapshot",
        method: "GET",
        payment: x402Info(
          "/api/x402/dev/repo-snapshot?repo=vercel/next.js",
          DEV_REPO_SNAPSHOT_X402_PRICE,
        ),
        endpointUrl: "/api/x402/dev/repo-snapshot?repo=vercel/next.js",
        inputSchema: {
          type: "object",
          required: ["repo"],
          properties: {
            repo: {
              type: "string",
              pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
              example: "vercel/next.js",
            },
          },
        },
      },
      {
        name: "current_weather_forecast_snapshot",
        endpoint: "/api/weather/current",
        method: "GET",
        payment: {
          mode: "free_preview",
          settlement: "paid x402 endpoint or service agreement for repeated use",
          payTo: PAY_TO,
        },
        endpointUrl: "/api/weather/current?latitude=37.7749&longitude=-122.4194",
        inputSchema: weatherInputSchema(),
      },
      {
        name: "paid_current_weather_forecast_snapshot",
        endpoint: "/api/x402/weather/current",
        method: "GET",
        payment: x402Info(
          "/api/x402/weather/current?latitude=37.7749&longitude=-122.4194",
          WEATHER_CURRENT_X402_PRICE,
        ),
        endpointUrl: "/api/x402/weather/current?latitude=37.7749&longitude=-122.4194",
        inputSchema: weatherInputSchema(),
      },
      {
        name: "target_wallet_signature_helper",
        endpoint: "/wallet-sign",
        method: "GET",
        payment: {
          mode: "free",
          settlement: "client-side wallet signature only",
          payTo: PAY_TO,
        },
        endpointUrl: "/wallet-sign",
        inputSchema: {
          type: "object",
          properties: {
            challenge: {
              type: "string",
              description:
                "A task-board challenge or typed-data JSON to sign from the connected wallet.",
            },
          },
        },
      },
      {
        name: "pyrimid_product_recommendations",
        endpoint: "/api/pyrimid/recommend",
        method: "GET",
        payment: {
          mode: "free",
          settlement:
            "affiliate recommendations only; purchases happen client-side through x402/Base USDC",
          affiliateId: PYRIMID_AFFILIATE_ID,
          payoutWallet: PAY_TO,
        },
        endpointUrl: "/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3",
        inputSchema: {
          type: "object",
          properties: {
            need: {
              type: "string",
              example: "paid mcp tool",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 10,
            },
            maxPriceUsd: {
              type: "number",
              minimum: 0,
              maximum: 1000,
            },
          },
        },
      },
      {
        name: "the402_provider_services",
        endpoint: "/api/the402/services",
        method: "GET",
        payment: {
          mode: "free",
          settlement:
            "service definitions only; purchased jobs settle through the402 escrow in USDC on Base",
          payoutWallet: PAY_TO,
        },
        endpointUrl: "/api/the402/services",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "the402_provider_webhook",
        endpoint: "/api/the402/webhook",
        method: "POST",
        payment: {
          mode: "marketplace_webhook",
          settlement: "the402 escrow, USDC on Base",
          payoutWallet: PAY_TO,
        },
        endpointUrl: "/api/the402/webhook",
        inputSchema: {
          type: "object",
          properties: {
            event: { type: "string" },
            job_id: { type: "string" },
            brief: { type: "object" },
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
          `/api/readiness?address=${SAMPLE_ADDRESS}`,
        method: "GET",
      },
      {
        id: "paid-agent-commerce-receipt",
        name: "Paid 800402 Agent Commerce Receipt",
        description:
          "Combines agent identity metadata, x402 Base USDC payment terms, and Base wallet-readiness evidence after an x402 payment.",
        uri:
          `/api/agent-commerce-receipt/${SAMPLE_ADDRESS}`,
        method: "GET",
      },
      {
        id: "daily-crypto-ohlcv-feed",
        name: "Daily BTC/ETH OHLCV Market Data Feed",
        description:
          "Cache-backed REST endpoint returning daily BTC/USD and ETH/USD OHLCV candles with optional API-key auth for buyer delivery.",
        uri: "/api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365",
        method: "GET",
      },
      {
        id: "top-crypto-price-snapshot-feed",
        name: "Top-50 Crypto Price Snapshot Feed",
        description:
          "Cache-backed REST endpoint returning top crypto assets by market cap with price, volume, market cap, 24h change, and Coinbase bid/ask spread where available.",
        uri: "/api/market/crypto-snapshot?limit=50",
        method: "GET",
      },
      {
        id: "post-top-crypto-price-snapshot-feed",
        name: "POST-compatible Top Crypto Price Snapshot Feed",
        description:
          "Marketplace/probe-friendly JSON POST wrapper around the top crypto price snapshot feed.",
        uri: "/api/market/crypto-snapshot",
        method: "POST",
      },
      {
        id: "paid-top-crypto-price-snapshot-feed",
        name: "Paid x402 Top Crypto Price Snapshot Feed",
        description:
          "Low-cost x402 endpoint returning top crypto assets by market cap with price, volume, 24h change, and Coinbase bid/ask spread where available.",
        uri: "/api/x402/market/crypto-snapshot?limit=50",
        method: "GET",
      },
      {
        id: "paid-daily-crypto-ohlcv-feed",
        name: "Paid x402 Daily Crypto OHLCV Feed",
        description:
          "Low-cost x402 endpoint returning daily BTC/USD, ETH/USD, or SOL/USD OHLCV candles from Coinbase Exchange public market data.",
        uri: "/api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365",
        method: "GET",
      },
      {
        id: "github-repo-intelligence-snapshot",
        name: "GitHub Repo Intelligence Snapshot",
        description:
          "Machine-readable public GitHub repo snapshot for agent scoping: metadata, languages, recent commits, latest release, and dependency signals.",
        uri: "/api/dev/repo-snapshot?repo=vercel/next.js",
        method: "GET",
      },
      {
        id: "paid-github-repo-intelligence-snapshot",
        name: "Paid x402 GitHub Repo Intelligence Snapshot",
        description:
          "Low-cost x402 developer-tool endpoint returning a public GitHub repo intelligence snapshot for agents and buyers.",
        uri: "/api/x402/dev/repo-snapshot?repo=vercel/next.js",
        method: "GET",
      },
      {
        id: "current-weather-forecast-snapshot",
        name: "Current Weather Forecast Snapshot",
        description:
          "Open-Meteo-backed current weather and short forecast snapshot for a WGS84 latitude/longitude pair.",
        uri: "/api/weather/current?latitude=37.7749&longitude=-122.4194",
        method: "GET",
      },
      {
        id: "paid-current-weather-forecast-snapshot",
        name: "Paid x402 Current Weather Forecast Snapshot",
        description:
          "Low-cost x402 endpoint returning current weather and daily forecast values from Open-Meteo for a WGS84 latitude/longitude pair.",
        uri: "/api/x402/weather/current?latitude=37.7749&longitude=-122.4194",
        method: "GET",
      },
      {
        id: "pyrimid-product-recommendations",
        name: "Pyrimid Product Recommendations",
        description:
          "Official @pyrimid/sdk resolver integration that recommends paid MCP/API products by natural-language need and returns x402 purchase metadata plus affiliate split estimates.",
        uri: "/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3",
        method: "GET",
      },
      {
        id: "the402-provider-services",
        name: "the402 Provider Service Definitions",
        description:
          "Dashboard/API-ready service definitions and webhook URL for listing Agent Commerce Desk on the402 marketplace without wallet custody.",
        uri: "/api/the402/services",
        method: "GET",
      },
      {
        id: "the402-provider-webhook",
        name: "the402 Provider Webhook",
        description:
          "HMAC-verifiable webhook receiver for the402 jobs. It auto-fulfills instant data API purchases and accepts manual implementation triage jobs.",
        uri: "/api/the402/webhook",
        method: "POST",
      },
      {
        id: "target-wallet-signature-helper",
        name: "Target Wallet Signature Helper",
        description:
          "Client-side wallet page for producing personal_sign or typed-data signatures from the published Base receiving wallet.",
        uri: "/wallet-sign",
        method: "GET",
      },
    ],
    payment: paymentInfo(),
    pyrimid: pyrimidInfo(),
    x402: x402Info(`/api/readiness/${SAMPLE_ADDRESS}`),
  });
});

app.get("/.well-known/x402", (_req, res) => {
  res.json(x402Manifest());
});

app.get("/.well-known/x402.json", (_req, res) => {
  res.json(x402Manifest());
});

app.get("/.well-known/402index-verify.txt", (_req, res) => {
  res.type("text/plain").send(`${FOUR_O_TWO_INDEX_VERIFICATION_HASH}\n`);
});

app.get("/llms.txt", (_req, res) => {
  res.type("text/plain").send(llmsTxt());
});

app.get("/wallet-sign", (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, "wallet-sign.html"));
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
        extensions: readinessDiscoveryExtension(),
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
        extensions: readinessDiscoveryExtension({ pathParams: true }),
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
        extensions: receiptDiscoveryExtension(),
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
        extensions: receiptDiscoveryExtension({ pathParams: true }),
      },
      "GET /api/x402/market/crypto-snapshot": {
        accepts: [
          {
            scheme: "exact",
            price: MARKET_SNAPSHOT_X402_PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Paid top crypto market snapshot: prices, market caps, 24h volume/change, and Coinbase bid/ask where available.",
        mimeType: "application/json",
        extensions: marketSnapshotDiscoveryExtension(),
      },
      "GET /api/x402/market/ohlcv": {
        accepts: [
          {
            scheme: "exact",
            price: MARKET_OHLCV_X402_PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Paid daily OHLCV market feed for BTC-USD, ETH-USD, and SOL-USD from Coinbase Exchange public data.",
        mimeType: "application/json",
        extensions: marketOhlcvDiscoveryExtension(),
      },
      "GET /api/x402/dev/repo-snapshot": {
        accepts: [
          {
            scheme: "exact",
            price: DEV_REPO_SNAPSHOT_X402_PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Paid GitHub repo intelligence snapshot for agent scoping: metadata, languages, recent commits, release, and dependency signals.",
        mimeType: "application/json",
        extensions: repoSnapshotDiscoveryExtension(),
      },
      "GET /api/x402/weather/current": {
        accepts: [
          {
            scheme: "exact",
            price: WEATHER_CURRENT_X402_PRICE,
            network: NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Paid current weather and short forecast snapshot for a latitude/longitude pair using Open-Meteo public forecast data.",
        mimeType: "application/json",
        extensions: weatherCurrentDiscoveryExtension(),
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

app.get("/api/x402/market/crypto-snapshot", async (req, res, next) => {
  try {
    res.json(await buildCryptoSnapshotFeed(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/x402/market/ohlcv", async (req, res, next) => {
  try {
    res.json(await buildMarketOhlcvFeed(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/x402/dev/repo-snapshot", async (req, res, next) => {
  try {
    res.json(await buildRepoSnapshot(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/x402/weather/current", async (req, res, next) => {
  try {
    res.json(await buildWeatherCurrent(req.query));
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

function requireMarketApiKey(req) {
  if (!MARKET_FEED_API_KEY) return;

  const auth = String(req.headers.authorization ?? "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  const candidate = String(req.headers["x-api-key"] ?? bearer);

  if (!constantTimeEqual(candidate, MARKET_FEED_API_KEY)) {
    const error = new Error("valid market feed API key required");
    error.statusCode = 401;
    throw error;
  }
}

function bodyToQuery(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return Object.fromEntries(
    Object.entries(body)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(",") : String(value),
      ]),
  );
}

function constantTimeEqual(candidate, expected) {
  if (!candidate || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

async function buildMarketOhlcvFeed(query) {
  const days = parseDays(query.days);
  const pairs = parsePairs(query.pairs);
  const startedAt = Date.now();
  const markets = await Promise.all(
    pairs.map((pair) => getDailyMarketCandles(pair, days)),
  );

  return {
    service: "Agent Commerce Desk Market Feed",
    version: serviceInfo.version,
    generatedAt: new Date().toISOString(),
    source: "Coinbase Exchange public candles API",
    auth: {
      mode: MARKET_FEED_API_KEY ? "api_key_required" : "demo_unlocked",
      acceptedHeaders: MARKET_FEED_API_KEY
        ? ["x-api-key", "authorization: Bearer <token>"]
        : [],
    },
    cache: {
      ttlSeconds: MARKET_CACHE_TTL_SECONDS,
      strategy: "in-memory per deployment instance",
    },
    request: {
      pairs,
      days,
      granularity: "1d",
    },
    markets,
    latencyMs: Date.now() - startedAt,
  };
}

async function buildCryptoSnapshotFeed(query) {
  const limit = parseSnapshotLimit(query.limit);
  const startedAt = Date.now();
  const assets = await getCryptoSnapshot(limit);

  return {
    service: "Agent Commerce Desk Crypto Snapshot Feed",
    version: serviceInfo.version,
    generatedAt: new Date().toISOString(),
    sources: {
      rankingAndMarketCap: "CoinGecko public markets API",
      executableUsdQuotes: "Coinbase Exchange public ticker API",
    },
    auth: {
      mode: MARKET_FEED_API_KEY ? "api_key_required" : "demo_unlocked",
      acceptedHeaders: MARKET_FEED_API_KEY
        ? ["x-api-key", "authorization: Bearer <token>"]
        : [],
    },
    cache: {
      ttlSeconds: MARKET_SNAPSHOT_CACHE_TTL_SECONDS,
      strategy: "in-memory per deployment instance",
    },
    request: {
      limit,
      quoteCurrency: "USD",
    },
    coverage: {
      requestedAssets: limit,
      returnedAssets: assets.length,
      coinbaseBidAskAssets: assets.filter((asset) => asset.coinbaseUsd).length,
    },
    assets,
    latencyMs: Date.now() - startedAt,
  };
}

async function buildWeatherCurrent(query) {
  const latitude = parseLatitude(query.latitude ?? query.lat);
  const longitude = parseLongitude(query.longitude ?? query.lon ?? query.lng);
  const forecastDays = parseWeatherForecastDays(query.forecast_days ?? query.days);
  const temperatureUnit = parseWeatherUnit(
    query.temperature_unit ?? query.temperatureUnit,
    ["celsius", "fahrenheit"],
    "celsius",
    "temperature_unit",
  );
  const windSpeedUnit = parseWeatherUnit(
    query.wind_speed_unit ?? query.windSpeedUnit,
    ["kmh", "ms", "mph", "kn"],
    "kmh",
    "wind_speed_unit",
  );
  const startedAt = Date.now();
  const url = new URL("/v1/forecast", OPEN_METEO_API);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "relative_humidity_2m",
      "apparent_temperature",
      "precipitation",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
  );
  url.searchParams.set(
    "daily",
    [
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
    ].join(","),
  );
  url.searchParams.set("forecast_days", String(forecastDays));
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const forecast = await fetchJson(url, "Open-Meteo forecast");
  const current = objectValue(forecast.current);
  const daily = objectValue(forecast.daily);

  return {
    service: "Agent Commerce Desk Current Weather Forecast Snapshot",
    version: serviceInfo.version,
    generatedAt: new Date().toISOString(),
    source: "Open-Meteo public forecast API",
    request: {
      latitude,
      longitude,
      forecastDays,
      temperatureUnit,
      windSpeedUnit,
    },
    location: {
      latitude: Number(forecast.latitude ?? latitude),
      longitude: Number(forecast.longitude ?? longitude),
      timezone: forecast.timezone ?? null,
      elevationMeters: numberOrNull(forecast.elevation),
    },
    current: {
      time: current.time ?? null,
      temperature: numberOrNull(current.temperature_2m),
      relativeHumidityPct: numberOrNull(current.relative_humidity_2m),
      apparentTemperature: numberOrNull(current.apparent_temperature),
      precipitation: numberOrNull(current.precipitation),
      weatherCode: numberOrNull(current.weather_code),
      windSpeed: numberOrNull(current.wind_speed_10m),
      windDirectionDegrees: numberOrNull(current.wind_direction_10m),
      units: {
        temperature: forecast.current_units?.temperature_2m ?? temperatureUnit,
        precipitation: forecast.current_units?.precipitation ?? null,
        windSpeed: forecast.current_units?.wind_speed_10m ?? windSpeedUnit,
      },
    },
    daily: normalizeWeatherDaily(daily, forecast.daily_units),
    latencyMs: Date.now() - startedAt,
  };
}

async function buildRepoSnapshot(query) {
  const repo = parseRepoSlug(query.repo ?? query.repository ?? query.url);
  const cacheKey = `github:repo:${repo.toLowerCase()}`;
  const now = Date.now();
  const cached = MARKET_CACHE.get(cacheKey);
  if (cached?.expiresAt > now) {
    return {
      ...cached.value,
      cache: { ...cached.value.cache, hit: true },
      latencyMs: 0,
    };
  }

  const startedAt = Date.now();
  const [owner, name] = repo.split("/");
  const repository = await fetchGitHubJson(
    `/repos/${owner}/${name}`,
    `GitHub repository ${repo}`,
  );
  const defaultBranch = String(repository.default_branch || "main");
  const [languages, commits, latestRelease, packageJson] = await Promise.all([
    fetchGitHubJson(`/repos/${owner}/${name}/languages`, `GitHub languages ${repo}`)
      .catch(() => ({})),
    fetchGitHubJson(
      `/repos/${owner}/${name}/commits?per_page=5&sha=${encodeURIComponent(defaultBranch)}`,
      `GitHub commits ${repo}`,
    ).catch(() => []),
    fetchGitHubJson(`/repos/${owner}/${name}/releases/latest`, `GitHub release ${repo}`)
      .catch((error) => {
        if (error.statusCode === 404) return null;
        throw error;
      }),
    fetchGitHubPackageJson(owner, name, defaultBranch),
  ]);
  const report = {
    service: "Agent Commerce Desk GitHub Repo Intelligence Snapshot",
    version: serviceInfo.version,
    generatedAt: new Date().toISOString(),
    source: "GitHub public REST API",
    request: { repo },
    repository: {
      fullName: repository.full_name,
      htmlUrl: repository.html_url,
      description: repository.description,
      defaultBranch,
      visibility: repository.visibility ?? (repository.private ? "private" : "public"),
      archived: Boolean(repository.archived),
      disabled: Boolean(repository.disabled),
      fork: Boolean(repository.fork),
      stars: Number(repository.stargazers_count ?? 0),
      forks: Number(repository.forks_count ?? 0),
      watchers: Number(repository.watchers_count ?? 0),
      openIssues: Number(repository.open_issues_count ?? 0),
      license: repository.license?.spdx_id ?? null,
      topics: Array.isArray(repository.topics) ? repository.topics.slice(0, 20) : [],
      pushedAt: repository.pushed_at,
      updatedAt: repository.updated_at,
      createdAt: repository.created_at,
    },
    languages: summarizeLanguages(languages),
    recentCommits: summarizeCommits(commits),
    latestRelease: latestRelease
      ? {
          tagName: latestRelease.tag_name,
          name: latestRelease.name,
          draft: Boolean(latestRelease.draft),
          prerelease: Boolean(latestRelease.prerelease),
          publishedAt: latestRelease.published_at,
          htmlUrl: latestRelease.html_url,
        }
      : null,
    packageJson,
    agentScoping: {
      suggestedFirstChecks: [
        "Read README and package/workspace manifests",
        "Run the narrowest available lint/type/test command",
        "Inspect open issues before proposing a patch",
      ],
      riskSignals: repoRiskSignals(repository, commits, packageJson),
      paidEndpoint:
        `${baseUrl()}/api/x402/dev/repo-snapshot?repo=${encodeURIComponent(repo)}`,
    },
    payment: {
      directX402Price: DEV_REPO_SNAPSHOT_X402_PRICE,
      asset: "native USDC",
      network: "Base",
      payTo: PAY_TO,
    },
    cache: {
      ttlSeconds: DEV_REPO_CACHE_TTL_SECONDS,
      strategy: "in-memory per deployment instance",
      hit: false,
    },
    latencyMs: Date.now() - startedAt,
  };

  MARKET_CACHE.set(cacheKey, {
    expiresAt: now + DEV_REPO_CACHE_TTL_SECONDS * 1000,
    value: report,
  });
  return report;
}

async function buildPyrimidRecommendations(query) {
  const need = parsePyrimidNeed(query.need);
  const limit = parseRecommendationLimit(query.limit);
  const maxPriceAtomic = parseMaxPriceAtomic(query.maxPriceUsd);
  const resolver = new PyrimidResolver({
    affiliateId: PYRIMID_AFFILIATE_ID,
    catalogUrl: PYRIMID_CATALOG_URL,
    maxPriceUsdc: maxPriceAtomic,
    preferVerifiedVendors: true,
  });
  const startedAt = Date.now();
  const [products, affiliateStats] = await Promise.all([
    resolver.findProducts(need, limit),
    resolver.getStats().catch((error) => ({
      error: error.message,
      registered: false,
    })),
  ]);

  return {
    service: "Agent Commerce Desk Pyrimid Recommender",
    version: serviceInfo.version,
    generatedAt: new Date().toISOString(),
    integration: pyrimidInfo(),
    request: {
      need,
      limit,
      maxPriceAtomic,
      maxPriceDisplay: formatUsdcAtomic(maxPriceAtomic),
    },
    affiliate: {
      id: PYRIMID_AFFILIATE_ID,
      payoutWallet: PAY_TO,
      stats: affiliateStats,
      purchaseHeader: {
        "X-Affiliate-ID": PYRIMID_AFFILIATE_ID,
      },
    },
    recommendations: products.map(toPyrimidRecommendation),
    safety: {
      custody: "no private keys or seed phrases are requested or stored",
      spending:
        "this endpoint only discovers/recommends products; buyers sign and pay in their own wallet runtime",
    },
    latencyMs: Date.now() - startedAt,
  };
}

async function handleThe402Webhook(req) {
  const payload = objectValue(req.body);
  const eventType = String(payload.event ?? payload.type ?? "webhook_test");
  const normalizedEvent = eventType.toLowerCase();

  if (THE402_WEBHOOK_SECRET) {
    verifyThe402Signature(req);
  } else if (normalizedEvent === "job_dispatch") {
    const error = new Error("THE402_WEBHOOK_SECRET is not configured");
    error.statusCode = 503;
    throw error;
  }

  if (["ping", "test", "webhook_test", "health_check"].includes(normalizedEvent)) {
    return {
      received: true,
      event: eventType,
      webhook: `${baseUrl()}/api/the402/webhook`,
      secretConfigured: Boolean(THE402_WEBHOOK_SECRET),
      services: the402ServiceDefinitions().map((service) => service.name),
    };
  }

  if (normalizedEvent === "job_dispatch") {
    return handleThe402JobDispatch(payload);
  }

  if (["thread_inquiry", "quote_request"].includes(normalizedEvent)) {
    return handleThe402Inquiry(payload, normalizedEvent);
  }

  return {
    received: true,
    event: eventType,
    status: "ignored_unknown_event",
  };
}

async function handleThe402JobDispatch(payload) {
  const serviceKey = inferThe402ServiceKey(payload);
  const brief = the402Brief(payload);
  const deliverables = await buildThe402Deliverables(serviceKey, brief);
  const callback =
    deliverables.autoComplete === true
      ? await maybePostThe402JobUpdate(payload, deliverables)
      : { posted: false, reason: "manual_or_quote_service" };

  return {
    received: true,
    event: "job_dispatch",
    jobId: payload.job_id ?? payload.id ?? null,
    serviceKey,
    status: deliverables.autoComplete ? "completed" : "accepted",
    deliverables,
    callback,
  };
}

function handleThe402Inquiry(payload, normalizedEvent) {
  const serviceKey = inferThe402ServiceKey(payload);
  const quote = buildThe402Quote(serviceKey, payload);

  return {
    received: true,
    event: normalizedEvent,
    threadId: payload.thread_id ?? payload.id ?? null,
    serviceKey,
    status: "ready_to_respond",
    quote,
  };
}

async function buildThe402Deliverables(serviceKey, brief) {
  if (serviceKey === "crypto_snapshot") {
    const report = await buildCryptoSnapshotFeed({
      limit: brief.limit ?? brief.assets ?? 50,
    });
    return {
      autoComplete: true,
      deliverableType: "crypto_snapshot",
      report,
    };
  }

  if (serviceKey === "ohlcv") {
    const report = await buildMarketOhlcvFeed({
      pairs: brief.pairs ?? brief.market_pairs ?? "BTC-USD,ETH-USD",
      days: brief.days ?? 365,
    });
    return {
      autoComplete: true,
      deliverableType: "ohlcv",
      report,
    };
  }

  if (serviceKey === "repo_snapshot") {
    const report = await buildRepoSnapshot({
      repo:
        brief.repo ??
        brief.repository ??
        brief.github_repo ??
        brief.repository_url ??
        brief.url,
    });
    return {
      autoComplete: true,
      deliverableType: "repo_snapshot",
      report,
    };
  }

  if (serviceKey === "wallet_readiness") {
    const address = String(brief.address ?? brief.wallet ?? brief.target_wallet ?? "");
    const report = await buildReadinessReport(address || SAMPLE_ADDRESS);
    return {
      autoComplete: true,
      deliverableType: "wallet_readiness",
      report,
      preview: toPreview(report),
    };
  }

  return {
    autoComplete: false,
    deliverableType: "implementation_intake",
    acceptedAt: new Date().toISOString(),
    summary:
      "Implementation request accepted for manual review. The provider will scope, execute, and return proof through the402 job thread.",
    requestedWork: brief,
    publicProof: {
      serviceManifest: `${baseUrl()}/manifest`,
      x402Manifest: `${baseUrl()}/.well-known/x402.json`,
      the402Manifest: `${baseUrl()}/.well-known/the402.json`,
    },
  };
}

async function maybePostThe402JobUpdate(payload, deliverables) {
  const updateUrl = String(
    payload.update_url ?? payload.callback_url ?? payload.result_url ?? "",
  );

  if (!updateUrl) {
    return { posted: false, reason: "missing_update_url" };
  }
  if (!THE402_API_KEY) {
    return { posted: false, reason: "THE402_API_KEY_not_configured" };
  }

  const response = await fetch(updateUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": THE402_API_KEY,
    },
    body: JSON.stringify({
      status: "completed",
      deliverables,
    }),
  });

  return {
    posted: response.ok,
    status: response.status,
    response: await response.text().catch(() => ""),
  };
}

function buildThe402Quote(serviceKey, payload) {
  const service =
    the402ServiceDefinitions().find((definition) =>
      inferThe402ServiceKey(definition) === serviceKey
    ) ??
    the402ServiceDefinitions().find((definition) =>
      inferThe402ServiceKey(definition) === "implementation_triage"
    );

  return {
    service: service.name,
    pricing: service.price,
    estimatedDelivery: service.estimated_delivery,
    providerWallet: PAY_TO,
    reply:
      serviceKey === "implementation_triage"
        ? "I can start with the fixed-price triage package and deliver a public proof bundle plus next patch steps."
        : "This service is ready through the listed webhook and can return structured JSON deliverables.",
    source: {
      threadId: payload.thread_id ?? null,
      respondUrl: payload.respond_url ?? payload.response_url ?? null,
    },
  };
}

function verifyThe402Signature(req) {
  const timestamp = String(req.headers["x-webhook-timestamp"] ?? "");
  const signatureHeader = String(req.headers["x-webhook-signature"] ?? "");
  const signature = signatureHeader.replace(/^sha256=/i, "");
  const rawBody = req.rawBody?.length
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body ?? {}));

  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    const error = new Error("invalid the402 webhook signature headers");
    error.statusCode = 401;
    throw error;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > THE402_WEBHOOK_TOLERANCE_SECONDS) {
    const error = new Error("stale the402 webhook timestamp");
    error.statusCode = 401;
    throw error;
  }

  const expected = createHmac("sha256", THE402_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  if (!constantTimeEqual(signature.toLowerCase(), expected)) {
    const error = new Error("invalid the402 webhook signature");
    error.statusCode = 401;
    throw error;
  }
}

function the402Brief(payload) {
  return objectValue(
    payload.brief ??
      payload.input ??
      payload.payload ??
      payload.arguments ??
      payload.request,
  );
}

function inferThe402ServiceKey(payload) {
  const haystack = JSON.stringify(payload).toLowerCase();

  if (
    haystack.includes("repo intelligence") ||
    haystack.includes("repo snapshot") ||
    haystack.includes("repository snapshot") ||
    haystack.includes("github repo") ||
    haystack.includes("\"repo\"") ||
    haystack.includes("\"repository\"") ||
    haystack.includes("\"github_repo\"")
  ) {
    return "repo_snapshot";
  }
  if (
    haystack.includes("triage") ||
    haystack.includes("integration") ||
    haystack.includes("debugging") ||
    haystack.includes("patch plan") ||
    haystack.includes("repository_or_url")
  ) {
    return "implementation_triage";
  }
  if (haystack.includes("ohlcv") || haystack.includes("candles")) {
    return "ohlcv";
  }
  if (
    haystack.includes("snapshot") ||
    haystack.includes("price") ||
    haystack.includes("market cap")
  ) {
    return "crypto_snapshot";
  }
  if (
    haystack.includes("wallet") ||
    haystack.includes("readiness") ||
    haystack.includes("payout address")
  ) {
    return "wallet_readiness";
  }
  return "implementation_triage";
}

function the402Manifest() {
  return {
    name: serviceInfo.name,
    provider_wallet: PAY_TO,
    network: "base",
    settlement_asset: "USDC",
    dashboard_url: "https://the402.ai/dashboard",
    webhook_url: `${baseUrl()}/api/the402/webhook`,
    webhook_health: `${baseUrl()}/api/the402/webhook`,
    source_manifest: `${baseUrl()}/manifest`,
    x402_manifest: `${baseUrl()}/.well-known/x402.json`,
    services: the402ServiceDefinitions(),
    secrets: {
      requiredForProduction: ["THE402_WEBHOOK_SECRET", "THE402_API_KEY"],
      custody: "No target wallet seed phrase or private key is required.",
    },
  };
}

function the402ServiceDefinitions() {
  const webhookUrl = `${baseUrl()}/api/the402/webhook`;
  return [
    {
      name: "Top Crypto Price Snapshot API",
      description:
        "Instant JSON snapshot of up to 50 crypto assets with price, market cap, 24h volume/change, and Coinbase USD bid/ask where available.",
      price: { fixed: "$0.05" },
      pricing_model: "fixed",
      service_type: "data_api",
      fulfillment_type: "instant",
      estimated_delivery: "10s",
      category: "data",
      tags: ["crypto", "market-data", "prices", "base", "x402"],
      webhook_url: webhookUrl,
      input_schema: {
        type: "object",
        required: [],
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Number of top assets to return.",
          },
        },
      },
      deliverable_schema: {
        type: "object",
        properties: {
          report: { type: "object" },
        },
      },
    },
    {
      name: "Daily Crypto OHLCV API",
      description:
        "Daily OHLCV candles for BTC-USD, ETH-USD, or SOL-USD from Coinbase Exchange public market data.",
      price: { fixed: "$0.10" },
      pricing_model: "fixed",
      service_type: "data_api",
      fulfillment_type: "instant",
      estimated_delivery: "10s",
      category: "data",
      tags: ["crypto", "ohlcv", "candles", "coinbase", "x402"],
      webhook_url: webhookUrl,
      input_schema: {
        type: "object",
        required: [],
        properties: {
          pairs: {
            type: "string",
            description: "Comma-separated pairs: BTC-USD, ETH-USD, SOL-USD.",
          },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 365,
          },
        },
      },
      deliverable_schema: {
        type: "object",
        properties: {
          report: { type: "object" },
        },
      },
    },
    {
      name: "Base Wallet Readiness Check",
      description:
        "Instant Base wallet check for native USDC balance, ETH balance, transaction count, token transfers, contract status, and explorer reputation before publishing a payout address.",
      price: { fixed: "$0.50" },
      pricing_model: "fixed",
      service_type: "data_api",
      fulfillment_type: "instant",
      estimated_delivery: "10s",
      category: "crypto",
      tags: ["base", "usdc", "wallet", "risk", "x402"],
      webhook_url: webhookUrl,
      input_schema: {
        type: "object",
        required: ["address"],
        properties: {
          address: {
            type: "string",
            pattern: "^0x[a-fA-F0-9]{40}$",
            description: "EVM address on Base to check.",
          },
        },
      },
      deliverable_schema: {
        type: "object",
        properties: {
          report: { type: "object" },
          preview: { type: "object" },
        },
      },
    },
    {
      name: "GitHub Repo Intelligence Snapshot API",
      description:
        "Instant public GitHub repo snapshot for agent scoping: repo metadata, language mix, recent commits, latest release, root package.json signals, and risk flags.",
      price: { fixed: "$0.15" },
      pricing_model: "fixed",
      service_type: "developer_tool_api",
      fulfillment_type: "instant",
      estimated_delivery: "10s",
      category: "development",
      tags: ["github", "repo-intelligence", "developer-tools", "code-review", "x402"],
      webhook_url: webhookUrl,
      input_schema: {
        type: "object",
        required: ["repo"],
        properties: {
          repo: {
            type: "string",
            pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
            description: "Public GitHub repository slug, for example vercel/next.js.",
          },
        },
      },
      deliverable_schema: {
        type: "object",
        properties: {
          report: { type: "object" },
        },
      },
    },
    {
      name: "Base USDC x402 Integration Triage",
      description:
        "Same-day implementation triage for a Base USDC/x402 endpoint, marketplace listing, webhook, or receipt verifier. Returns findings, proof links, and a concrete patch plan.",
      price: { fixed: "$100" },
      pricing_model: "fixed",
      service_type: "human_service",
      fulfillment_type: "human",
      estimated_delivery: "24h",
      category: "development",
      tags: ["x402", "base", "usdc", "integration", "debugging"],
      webhook_url: webhookUrl,
      input_schema: {
        type: "object",
        required: ["repository_or_url", "goal"],
        properties: {
          repository_or_url: {
            type: "string",
            description: "GitHub repo, deployment URL, API docs, or failing endpoint.",
          },
          goal: {
            type: "string",
            description: "What should work when the triage is complete.",
          },
          constraints: {
            type: "string",
            description: "Deployment, wallet, security, or deadline constraints.",
          },
        },
      },
      deliverable_schema: {
        type: "object",
        properties: {
          findings: { type: "string" },
          proof_urls: { type: "array", items: { type: "string" } },
          patch_plan: { type: "string" },
        },
      },
    },
  ];
}

function parseSnapshotLimit(rawLimit) {
  const limit = Number(rawLimit || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    const error = new Error("limit must be an integer between 1 and 50");
    error.statusCode = 400;
    throw error;
  }
  return limit;
}

function parseRepoSlug(rawRepo) {
  const value = String(rawRepo || "").trim();
  const match = value.match(
    /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/.*)?$/,
  );
  if (!match) {
    const error = new Error("repo must be a GitHub repository slug like owner/name");
    error.statusCode = 400;
    throw error;
  }

  return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
}

function parsePyrimidNeed(rawNeed) {
  const need = String(rawNeed || "paid mcp tool").trim();
  if (need.length < 2 || need.length > 160) {
    const error = new Error("need must be between 2 and 160 characters");
    error.statusCode = 400;
    throw error;
  }
  return need;
}

function parseRecommendationLimit(rawLimit) {
  const limit = Number(rawLimit || 5);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    const error = new Error("limit must be an integer between 1 and 10");
    error.statusCode = 400;
    throw error;
  }
  return limit;
}

function parseMaxPriceAtomic(rawMaxPriceUsd) {
  if (rawMaxPriceUsd == null || rawMaxPriceUsd === "") {
    return PYRIMID_DEFAULT_MAX_PRICE_ATOMIC;
  }

  const maxPriceUsd = Number(rawMaxPriceUsd);
  if (!Number.isFinite(maxPriceUsd) || maxPriceUsd <= 0 || maxPriceUsd > 1000) {
    const error = new Error("maxPriceUsd must be a number greater than 0 and at most 1000");
    error.statusCode = 400;
    throw error;
  }
  return Math.round(maxPriceUsd * 1_000_000);
}

function toPyrimidRecommendation(product, index) {
  const split = calculateSplit(product.price_usdc, product.affiliate_bps);

  return {
    rank: index + 1,
    productId: product.product_id,
    vendorId: product.vendor_id,
    vendorName: product.vendor_name,
    description: product.description,
    category: product.category,
    tags: product.tags,
    endpoint: product.endpoint,
    method: product.method,
    network: product.network,
    asset: product.asset,
    source: product.source,
    sdkIntegrated: Boolean(product.sdk_integrated),
    price: {
      atomic: product.price_usdc,
      display: product.price_display ?? formatUsdcAtomic(product.price_usdc),
    },
    affiliate: {
      id: PYRIMID_AFFILIATE_ID,
      bps: product.affiliate_bps,
      estimatedSplit: {
        protocolFee: {
          atomic: split.protocol_fee,
          display: formatUsdcAtomic(split.protocol_fee),
        },
        affiliateCommission: {
          atomic: split.affiliate_commission,
          display: formatUsdcAtomic(split.affiliate_commission),
        },
        vendorShare: {
          atomic: split.vendor_share,
          display: formatUsdcAtomic(split.vendor_share),
        },
      },
    },
    purchase: {
      requestHeaders: {
        "X-Affiliate-ID": PYRIMID_AFFILIATE_ID,
      },
      expectedFirstResponse:
        "HTTP 402 with Base USDC x402 payment requirements before buyer-side payment",
    },
  };
}

async function fetchGitHubPackageJson(owner, name, defaultBranch) {
  try {
    const file = await fetchGitHubJson(
      `/repos/${owner}/${name}/contents/package.json?ref=${encodeURIComponent(defaultBranch)}`,
      `GitHub package.json ${owner}/${name}`,
    );
    if (file?.encoding !== "base64" || typeof file.content !== "string") return null;
    const parsed = JSON.parse(
      Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
    );
    return summarizePackageJson(parsed);
  } catch (error) {
    if (error.statusCode === 404 || error instanceof SyntaxError) return null;
    throw error;
  }
}

function summarizeLanguages(languages) {
  const entries = Object.entries(objectValue(languages))
    .filter(([, bytes]) => Number.isFinite(Number(bytes)) && Number(bytes) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  const totalBytes = entries.reduce((sum, [, bytes]) => sum + Number(bytes), 0);

  return {
    totalBytes,
    primary: entries[0]?.[0] ?? null,
    breakdown: entries.slice(0, 8).map(([language, bytes]) => ({
      language,
      bytes: Number(bytes),
      percent:
        totalBytes > 0 ? Number(((Number(bytes) / totalBytes) * 100).toFixed(2)) : 0,
    })),
  };
}

function summarizeCommits(commits) {
  return (Array.isArray(commits) ? commits : []).slice(0, 5).map((commit) => ({
    sha: String(commit.sha ?? "").slice(0, 12),
    message: firstLine(commit.commit?.message, 180),
    authorName: commit.commit?.author?.name ?? commit.author?.login ?? null,
    committedAt: commit.commit?.author?.date ?? null,
    htmlUrl: commit.html_url ?? null,
  }));
}

function summarizePackageJson(pkg) {
  const scripts = objectValue(pkg.scripts);
  const dependencyGroups = {
    dependencies: objectValue(pkg.dependencies),
    devDependencies: objectValue(pkg.devDependencies),
    peerDependencies: objectValue(pkg.peerDependencies),
    optionalDependencies: objectValue(pkg.optionalDependencies),
  };
  const dependencyNames = Object.values(dependencyGroups).flatMap((group) =>
    Object.keys(group)
  );

  return {
    name: typeof pkg.name === "string" ? pkg.name : null,
    version: typeof pkg.version === "string" ? pkg.version : null,
    type: typeof pkg.type === "string" ? pkg.type : null,
    packageManager:
      typeof pkg.packageManager === "string" ? pkg.packageManager : null,
    scripts: Object.keys(scripts).sort().slice(0, 20),
    dependencyCounts: Object.fromEntries(
      Object.entries(dependencyGroups).map(([group, values]) => [
        group,
        Object.keys(values).length,
      ]),
    ),
    notableDependencies: dependencyNames
      .filter((name) =>
        [
          "@vercel/ai",
          "ai",
          "express",
          "fastify",
          "hono",
          "jest",
          "next",
          "playwright",
          "react",
          "tailwindcss",
          "typescript",
          "vite",
          "vitest",
          "vue",
        ].includes(name)
      )
      .sort(),
  };
}

function repoRiskSignals(repository, commits, packageJson) {
  const signals = [];
  const lastPushMs = Date.parse(repository.pushed_at ?? "");
  const daysSincePush = Number.isFinite(lastPushMs)
    ? Math.floor((Date.now() - lastPushMs) / (24 * 60 * 60 * 1000))
    : null;

  if (repository.archived) signals.push("repository_archived");
  if (repository.disabled) signals.push("repository_disabled");
  if (Number(repository.open_issues_count ?? 0) > 1000) {
    signals.push("high_open_issue_count");
  }
  if (daysSincePush != null && daysSincePush > 365) {
    signals.push("stale_default_branch_activity");
  }
  if (!Array.isArray(commits) || commits.length === 0) {
    signals.push("recent_commits_unavailable");
  }
  if (!packageJson) {
    signals.push("root_package_json_not_found");
  }

  return signals;
}

function firstLine(value, maxLength) {
  const line = String(value ?? "").split("\n")[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}...` : line;
}

function formatUsdcAtomic(value) {
  return `$${(Number(value) / 1_000_000).toFixed(6).replace(/\.?0+$/, "")}`;
}

async function getCryptoSnapshot(limit) {
  const cacheKey = `snapshot:${limit}`;
  const now = Date.now();
  const cached = MARKET_CACHE.get(cacheKey);
  if (cached?.expiresAt > now) {
    return cached.value.map((asset) => ({ ...asset, cacheHit: true }));
  }

  const [markets, usdProducts] = await Promise.all([
    fetchCoinGeckoMarkets(limit),
    fetchCoinbaseUsdProducts(),
  ]);
  const assets = await mapWithConcurrency(markets, 8, async (market) => {
    const symbol = String(market.symbol ?? "").toUpperCase();
    const product = usdProducts.get(symbol);
    const coinbase = product ? await fetchCoinbaseTicker(product.id) : null;
    const bid = coinbase?.bid ? Number(coinbase.bid) : null;
    const ask = coinbase?.ask ? Number(coinbase.ask) : null;

    return {
      rank: Number(market.market_cap_rank ?? 0),
      id: market.id,
      symbol,
      name: market.name,
      priceUsd: Number(market.current_price ?? 0),
      marketCapUsd: Number(market.market_cap ?? 0),
      volume24hUsd: Number(market.total_volume ?? 0),
      priceChange24hPct:
        market.price_change_percentage_24h == null
          ? null
          : Number(market.price_change_percentage_24h),
      coinbaseUsd: product
        ? {
            productId: product.id,
            bid,
            ask,
            last: coinbase?.price ? Number(coinbase.price) : null,
            spread: bid != null && ask != null ? Number((ask - bid).toFixed(10)) : null,
            spreadPct:
              bid != null && ask != null && ask > 0
                ? Number((((ask - bid) / ask) * 100).toFixed(6))
                : null,
            exchangeVolume24h: coinbase?.volume ? Number(coinbase.volume) : null,
            quoteTime: coinbase?.time ?? null,
          }
        : null,
      cacheHit: false,
    };
  });

  MARKET_CACHE.set(cacheKey, {
    expiresAt: now + MARKET_SNAPSHOT_CACHE_TTL_SECONDS * 1000,
    value: assets,
  });

  return assets;
}

async function fetchCoinGeckoMarkets(limit) {
  const url = new URL("/api/v3/coins/markets", COINGECKO_API);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  url.searchParams.set("price_change_percentage", "24h");

  const rows = await fetchJson(url, "CoinGecko markets");
  if (!Array.isArray(rows)) {
    throw new Error("CoinGecko markets response was not an array");
  }
  return rows;
}

async function fetchCoinbaseUsdProducts() {
  const cacheKey = "coinbase:usd-products";
  const now = Date.now();
  const cached = MARKET_CACHE.get(cacheKey);
  if (cached?.expiresAt > now) return cached.value;

  const products = await fetchJson(
    new URL("/products", COINBASE_EXCHANGE_API),
    "Coinbase products",
  );
  if (!Array.isArray(products)) {
    throw new Error("Coinbase products response was not an array");
  }

  const byBase = new Map();
  for (const product of products) {
    if (
      product.quote_currency === "USD" &&
      product.trading_disabled === false &&
      typeof product.base_currency === "string"
    ) {
      byBase.set(product.base_currency.toUpperCase(), { id: product.id });
    }
  }

  MARKET_CACHE.set(cacheKey, {
    expiresAt: now + 15 * 60 * 1000,
    value: byBase,
  });

  return byBase;
}

async function fetchCoinbaseTicker(productId) {
  try {
    return await fetchJson(
      new URL(`/products/${productId}/ticker`, COINBASE_EXCHANGE_API),
      `Coinbase ticker ${productId}`,
    );
  } catch (_error) {
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function parsePairs(rawPairs) {
  const pairs = String(rawPairs || "BTC-USD,ETH-USD")
    .split(",")
    .map((pair) => pair.trim().toUpperCase().replace("/", "-"))
    .filter(Boolean);

  if (pairs.length === 0 || pairs.length > 5) {
    const error = new Error("pairs must include between 1 and 5 symbols");
    error.statusCode = 400;
    throw error;
  }

  for (const pair of pairs) {
    if (!MARKET_ALLOWED_PAIRS.has(pair)) {
      const error = new Error(
        `unsupported pair ${pair}; supported pairs: ${[...MARKET_ALLOWED_PAIRS].join(", ")}`,
      );
      error.statusCode = 400;
      throw error;
    }
  }

  return [...new Set(pairs)];
}

function parseDays(rawDays) {
  const days = Number(rawDays || 365);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    const error = new Error("days must be an integer between 1 and 365");
    error.statusCode = 400;
    throw error;
  }
  return days;
}

function parseLatitude(rawLatitude) {
  const latitude = Number(rawLatitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    const error = new Error("latitude must be a number between -90 and 90");
    error.statusCode = 400;
    throw error;
  }
  return Number(latitude.toFixed(6));
}

function parseLongitude(rawLongitude) {
  const longitude = Number(rawLongitude);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    const error = new Error("longitude must be a number between -180 and 180");
    error.statusCode = 400;
    throw error;
  }
  return Number(longitude.toFixed(6));
}

function parseWeatherForecastDays(rawDays) {
  const days = Number(rawDays || 3);
  if (!Number.isInteger(days) || days < 1 || days > 7) {
    const error = new Error("forecast_days must be an integer between 1 and 7");
    error.statusCode = 400;
    throw error;
  }
  return days;
}

function parseWeatherUnit(rawUnit, allowed, fallback, name) {
  const unit = String(rawUnit || fallback).toLowerCase();
  if (!allowed.includes(unit)) {
    const error = new Error(`${name} must be one of: ${allowed.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return unit;
}

function normalizeWeatherDaily(daily, units = {}) {
  const times = Array.isArray(daily.time) ? daily.time : [];
  return times.map((date, index) => ({
    date,
    temperatureMax: numberOrNull(daily.temperature_2m_max?.[index]),
    temperatureMin: numberOrNull(daily.temperature_2m_min?.[index]),
    precipitationSum: numberOrNull(daily.precipitation_sum?.[index]),
    precipitationProbabilityMaxPct: numberOrNull(
      daily.precipitation_probability_max?.[index],
    ),
    units: {
      temperature: units.temperature_2m_max ?? null,
      precipitation: units.precipitation_sum ?? null,
      precipitationProbability: units.precipitation_probability_max ?? null,
    },
  }));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function getDailyMarketCandles(pair, days) {
  const cacheKey = `${pair}:${days}`;
  const now = Date.now();
  const cached = MARKET_CACHE.get(cacheKey);
  if (cached?.expiresAt > now) {
    return { ...cached.value, cacheHit: true };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const nowDate = new Date();
  const endMs = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
  );
  const startMs = endMs - days * dayMs;
  const candles = await fetchCoinbaseDailyCandles(pair, startMs, endMs);
  const [base, quote] = pair.split("-");
  const value = {
    pair,
    base,
    quote,
    granularitySeconds: 86400,
    daysRequested: days,
    start: new Date(startMs).toISOString(),
    endExclusive: new Date(endMs).toISOString(),
    refreshedAt: new Date().toISOString(),
    count: candles.length,
    candles,
  };

  MARKET_CACHE.set(cacheKey, {
    expiresAt: now + MARKET_CACHE_TTL_SECONDS * 1000,
    value,
  });

  return { ...value, cacheHit: false };
}

async function fetchCoinbaseDailyCandles(pair, startMs, endMs) {
  const dayMs = 24 * 60 * 60 * 1000;
  const maxChunkDays = 280;
  const byTimestamp = new Map();

  for (let cursor = startMs; cursor < endMs; cursor += maxChunkDays * dayMs) {
    const chunkEnd = Math.min(cursor + maxChunkDays * dayMs, endMs);
    const url = new URL(`/products/${pair}/candles`, COINBASE_EXCHANGE_API);
    url.searchParams.set("granularity", "86400");
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(chunkEnd).toISOString());

    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "codex-agent-market-feed/0.1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`Coinbase candles request failed: ${response.status}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) {
      throw new Error("Coinbase candles response was not an array");
    }

    for (const row of rows) {
      const [time, low, high, open, close, volume] = row;
      const timeMs = Number(time) * 1000;
      if (timeMs < startMs || timeMs >= endMs) continue;
      byTimestamp.set(Number(time), {
        timestamp: new Date(timeMs).toISOString(),
        date: new Date(timeMs).toISOString().slice(0, 10),
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
      });
    }
  }

  return [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, candle]) => candle);
}

function normalizeAddress(address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    const error = new Error("address must be a 20-byte EVM address");
    error.statusCode = 400;
    throw error;
  }
  return address;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function previewAddress(req) {
  const body = objectValue(req.body);
  const input = objectValue(body.input);
  const payload = objectValue(body.payload);
  const args = objectValue(body.arguments);

  return String(
    req.params.address ??
      req.query.address ??
      body.address ??
      input.address ??
      payload.address ??
      args.address ??
      ""
  );
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
        endpoint: `${baseUrl()}/api/readiness/${SAMPLE_ADDRESS}`,
      },
      {
        name: "800402 agent commerce receipt",
        transport: "https",
        payment: "x402",
        endpoint: `${baseUrl()}/api/agent-commerce-receipt/${SAMPLE_ADDRESS}`,
      },
      {
        name: "Target wallet signature helper",
        transport: "https",
        payment: "free",
        endpoint: `${baseUrl()}/wallet-sign`,
      },
      {
        name: "Pyrimid product recommendations",
        transport: "https",
        payment: "free",
        endpoint: `${baseUrl()}/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3`,
      },
      {
        name: "GitHub repo intelligence snapshot",
        transport: "https",
        payment: "x402",
        endpoint: `${baseUrl()}/api/x402/dev/repo-snapshot?repo=vercel/next.js`,
      },
    ],
    supportedTrust: ["erc-8004", "x402", "base-usdc"],
  };
}

function pyrimidInfo() {
  return {
    sdk: "@pyrimid/sdk",
    integrationPath: "embedded_resolver",
    catalogUrl: PYRIMID_CATALOG_URL,
    affiliateId: PYRIMID_AFFILIATE_ID,
    payoutWallet: PAY_TO,
    recommendationEndpoint:
      `${baseUrl()}/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3`,
    docs: "https://pyrimid.ai/quickstart",
  };
}

function paymentInfo() {
  return {
    asset: "native USDC",
    assetContract: USDC_CONTRACT,
    network: "Base",
    networkCaip2: NETWORK,
    facilitator: ACTIVE_FACILITATOR_URL,
    payTo: PAY_TO,
    priceUsd: priceUsd(),
  };
}

function x402Info(path, price = PRICE) {
  return {
    endpoint: `${baseUrl()}${path}`,
    method: "GET",
    priceUsd: priceUsd(price),
    asset: USDC_CONTRACT,
    network: NETWORK,
    facilitator: ACTIVE_FACILITATOR_URL,
    payTo: PAY_TO,
  };
}

function x402Manifest() {
  return {
    x402Version: 2,
    name: serviceInfo.name,
    description: serviceInfo.description,
    homepage: baseUrl(),
    manifest: `${baseUrl()}/manifest`,
    agentCard: `${baseUrl()}/.well-known/agent-card.json`,
    network: NETWORK,
    facilitator: ACTIVE_FACILITATOR_URL,
    settlement: {
      asset: "native USDC",
      assetContract: USDC_CONTRACT,
      network: "Base",
      networkCaip2: NETWORK,
      payTo: PAY_TO,
    },
    resources: [
      {
        url: `${baseUrl()}/api/readiness/${SAMPLE_ADDRESS}`,
        method: "GET",
        description:
          "Paid Base wallet readiness report with ETH balance, native USDC balance, tx count, token transfers, and contract status.",
        mimeType: "application/json",
        accepts: [x402Accept()],
      },
      {
        url: `${baseUrl()}/api/agent-commerce-receipt/${SAMPLE_ADDRESS}`,
        method: "GET",
        description:
          "Paid 800402 agent commerce receipt combining identity metadata, x402 payment terms, and wallet-readiness evidence.",
        mimeType: "application/json",
        accepts: [x402Accept()],
      },
      {
        url: `${baseUrl()}/api/x402/market/crypto-snapshot?limit=50`,
        method: "GET",
        description:
          "Paid top crypto market snapshot with market cap rank, price, 24h volume/change, and Coinbase bid/ask where available.",
        mimeType: "application/json",
        accepts: [x402Accept(MARKET_SNAPSHOT_X402_PRICE)],
      },
      {
        url: `${baseUrl()}/api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365`,
        method: "GET",
        description:
          "Paid daily OHLCV market feed for BTC-USD, ETH-USD, and SOL-USD from Coinbase Exchange public data.",
        mimeType: "application/json",
        accepts: [x402Accept(MARKET_OHLCV_X402_PRICE)],
      },
      {
        url: `${baseUrl()}/api/x402/dev/repo-snapshot?repo=vercel/next.js`,
        method: "GET",
        description:
          "Paid GitHub repo intelligence snapshot for agent scoping with metadata, languages, recent commits, release, and dependency signals.",
        mimeType: "application/json",
        accepts: [x402Accept(DEV_REPO_SNAPSHOT_X402_PRICE)],
      },
      {
        url: `${baseUrl()}/api/x402/weather/current?latitude=37.7749&longitude=-122.4194`,
        method: "GET",
        description:
          "Paid current weather and short forecast snapshot for a WGS84 latitude/longitude pair using Open-Meteo public forecast data.",
        mimeType: "application/json",
        accepts: [x402Accept(WEATHER_CURRENT_X402_PRICE)],
      },
    ],
  };
}

function llmsTxt() {
  const sampleAddress = SAMPLE_ADDRESS;
  return `# ${serviceInfo.name}

${serviceInfo.description}

Base URL: ${baseUrl()}
Payment rail: x402 exact payments, native USDC on Base (${NETWORK})
Receiving wallet: ${PAY_TO}
Default paid API price: ${PRICE}
Facilitator: ${ACTIVE_FACILITATOR_URL}

## Free discovery endpoints

- GET ${baseUrl()}/manifest
- GET ${baseUrl()}/.well-known/agent-card.json
- GET ${baseUrl()}/.well-known/agent.json
- GET ${baseUrl()}/.well-known/x402
- GET ${baseUrl()}/.well-known/x402.json
- GET ${baseUrl()}/llms.txt
- GET ${baseUrl()}/api/800402/preview
- GET ${baseUrl()}/api/preview?address=${sampleAddress}
- GET ${baseUrl()}/api/market/crypto-snapshot?limit=50
- GET ${baseUrl()}/api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365
- GET ${baseUrl()}/api/dev/repo-snapshot?repo=vercel/next.js
- GET ${baseUrl()}/api/weather/current?latitude=37.7749&longitude=-122.4194
- GET ${baseUrl()}/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3
- GET ${baseUrl()}/api/the402/services
- GET ${baseUrl()}/.well-known/the402.json
- GET ${baseUrl()}/api/the402/webhook

## Paid x402 endpoints

- GET ${baseUrl()}/api/readiness/${sampleAddress}
- GET ${baseUrl()}/api/agent-commerce-receipt/${sampleAddress}
- GET ${baseUrl()}/api/x402/market/crypto-snapshot?limit=50
- GET ${baseUrl()}/api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365
- GET ${baseUrl()}/api/x402/dev/repo-snapshot?repo=vercel/next.js
- GET ${baseUrl()}/api/x402/weather/current?latitude=37.7749&longitude=-122.4194

## the402 provider webhook

- POST ${baseUrl()}/api/the402/webhook

Configure THE402_WEBHOOK_SECRET and THE402_API_KEY after provider onboarding.
The webhook auto-fulfills instant data API jobs and accepts manual x402/Base
USDC implementation triage jobs without storing wallet private keys.

Use the x402 manifest for exact payment requirements before calling paid endpoints.
`;
}

function readinessDiscoveryExtension(options = {}) {
  return walletAddressDiscoveryExtension({
    ...options,
    output: { example: readinessBazaarOutput().example },
  });
}

function receiptDiscoveryExtension(options = {}) {
  return walletAddressDiscoveryExtension({
    ...options,
    output: { example: receiptBazaarOutput().example },
  });
}

function marketSnapshotDiscoveryExtension() {
  return declareDiscoveryExtension({
    method: "GET",
    input: { limit: 50 },
    inputSchema: {
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Number of ranked assets to return.",
        },
      },
      additionalProperties: false,
    },
    output: {
      type: "json",
      example: {
        service: "Agent Commerce Desk Crypto Snapshot Feed",
        request: { limit: 50, quoteCurrency: "USD" },
        coverage: {
          requestedAssets: 50,
          returnedAssets: 50,
          coinbaseBidAskAssets: 30,
        },
        assets: [
          {
            rank: 1,
            symbol: "BTC",
            priceUsd: 76719,
            marketCapUsd: 1536988094000,
            volume24hUsd: 30752643861,
            priceChange24hPct: 3.00933,
          },
        ],
      },
    },
  });
}

function marketOhlcvDiscoveryExtension() {
  return declareDiscoveryExtension({
    method: "GET",
    input: { pairs: "BTC-USD,ETH-USD", days: 365 },
    inputSchema: {
      properties: {
        pairs: {
          type: "string",
          description:
            "Comma-separated Coinbase pairs. Supported: BTC-USD, ETH-USD, SOL-USD.",
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 365,
        },
      },
      additionalProperties: false,
    },
    output: {
      type: "json",
      example: {
        service: "Agent Commerce Desk Market Feed",
        request: {
          pairs: ["BTC-USD", "ETH-USD"],
          days: 365,
          granularity: "1d",
        },
        markets: [
          {
            pair: "BTC-USD",
            count: 365,
            candles: [
              {
                date: "2026-05-23",
                open: 75446.99,
                high: 77305,
                low: 74197.11,
                close: 76650,
                volume: 5619.0521439,
              },
            ],
          },
        ],
      },
    },
  });
}

function repoSnapshotDiscoveryExtension() {
  return declareDiscoveryExtension({
    method: "GET",
    input: { repo: "vercel/next.js" },
    inputSchema: {
      properties: {
        repo: {
          type: "string",
          pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
          description: "Public GitHub repository slug.",
        },
      },
      required: ["repo"],
      additionalProperties: false,
    },
    output: {
      type: "json",
      example: {
        service: "Agent Commerce Desk GitHub Repo Intelligence Snapshot",
        request: { repo: "vercel/next.js" },
        repository: {
          fullName: "vercel/next.js",
          stars: 130000,
          openIssues: 3000,
          defaultBranch: "canary",
        },
        languages: {
          primary: "TypeScript",
          breakdown: [{ language: "TypeScript", percent: 80 }],
        },
        agentScoping: {
          riskSignals: ["high_open_issue_count"],
        },
      },
    },
  });
}

function weatherCurrentDiscoveryExtension() {
  return declareDiscoveryExtension({
    method: "GET",
    input: { latitude: 37.7749, longitude: -122.4194, forecast_days: 3 },
    inputSchema: weatherInputSchema(),
    output: {
      type: "json",
      example: {
        service: "Agent Commerce Desk Current Weather Forecast Snapshot",
        source: "Open-Meteo public forecast API",
        request: {
          latitude: 37.7749,
          longitude: -122.4194,
          forecastDays: 3,
          temperatureUnit: "celsius",
          windSpeedUnit: "kmh",
        },
        current: {
          time: "2026-05-24T12:00",
          temperature: 18.2,
          relativeHumidityPct: 72,
          apparentTemperature: 17.5,
          precipitation: 0,
          weatherCode: 2,
          windSpeed: 16.1,
          windDirectionDegrees: 260,
        },
        daily: [
          {
            date: "2026-05-24",
            temperatureMax: 19.8,
            temperatureMin: 12.4,
            precipitationSum: 0.1,
            precipitationProbabilityMaxPct: 12,
          },
        ],
      },
    },
  });
}

function weatherInputSchema() {
  return {
    type: "object",
    required: ["latitude", "longitude"],
    properties: {
      latitude: {
        type: "number",
        minimum: -90,
        maximum: 90,
        description: "WGS84 latitude.",
      },
      longitude: {
        type: "number",
        minimum: -180,
        maximum: 180,
        description: "WGS84 longitude.",
      },
      forecast_days: {
        type: "integer",
        minimum: 1,
        maximum: 7,
        description: "Number of daily forecast rows to return.",
      },
      temperature_unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
      },
      wind_speed_unit: {
        type: "string",
        enum: ["kmh", "ms", "mph", "kn"],
      },
    },
    additionalProperties: false,
  };
}

function walletAddressDiscoveryExtension({ pathParams = false, output }) {
  const addressSchema = {
    properties: {
      address: {
        type: "string",
        pattern: "^0x[a-fA-F0-9]{40}$",
        description: "EVM wallet address on Base.",
      },
    },
    required: ["address"],
    additionalProperties: false,
  };

  if (pathParams) {
    return declareDiscoveryExtension({
      method: "GET",
      input: null,
      pathParams: { address: SAMPLE_ADDRESS },
      pathParamsSchema: addressSchema,
      output,
    });
  }

  return declareDiscoveryExtension({
    method: "GET",
    input: { address: SAMPLE_ADDRESS },
    inputSchema: addressSchema,
    output,
  });
}

function readinessBazaarOutput() {
  return {
    type: "json",
    example: {
      address: SAMPLE_ADDRESS,
      network: "base",
      native_usdc_balance: "0",
      native_eth_balance: "0",
      transaction_count: 0,
      token_transfers: 0,
      is_contract: false,
    },
  };
}

function receiptBazaarOutput() {
  return {
    type: "json",
    example: {
      receiptType: "agent-commerce-readiness",
      agent: {
        name: serviceInfo.name,
        wallet: PAY_TO,
      },
      payment: paymentInfo(),
      walletReadiness: {
        address: SAMPLE_ADDRESS,
        native_usdc_balance: "0",
        is_contract: false,
      },
    },
  };
}

function x402Accept(price = PRICE) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: String(Math.round(priceUsd(price) * 1_000_000)),
    asset: USDC_CONTRACT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
    },
  };
}

function baseUrl() {
  return (PUBLIC_URL?.toString() ?? "http://localhost:4021").replace(/\/$/, "");
}

function priceUsd(price = PRICE) {
  return Number(String(price).replace(/^\$/, ""));
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

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "codex-agent-market-feed/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`${label} request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchGitHubJson(path, label) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "agent-commerce-desk-repo-snapshot/0.1.0",
    "x-github-api-version": "2022-11-28",
  };
  if (GITHUB_PUBLIC_API_TOKEN) {
    headers.authorization = `Bearer ${GITHUB_PUBLIC_API_TOKEN}`;
  }

  const response = await fetch(new URL(path, GITHUB_API), { headers });
  if (!response.ok) {
    const error = new Error(`${label} request failed: ${response.status}`);
    error.statusCode = response.status;
    throw error;
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
