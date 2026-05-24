import express from "express";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import { calculateSplit } from "@pyrimid/sdk/middleware";
import { PyrimidResolver } from "@pyrimid/sdk/resolver";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";

const PAY_TO =
  process.env.PAY_TO ?? "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9";
const SAMPLE_ADDRESS = process.env.SAMPLE_ADDRESS ?? PAY_TO;
const PORT = Number(process.env.PORT ?? "4021");
const NETWORK = process.env.X402_NETWORK ?? "eip155:8453";
const PRICE = process.env.X402_PRICE ?? "$2";
const BASE_RPC = process.env.BASE_RPC ?? "https://mainnet.base.org";
const COINBASE_EXCHANGE_API =
  process.env.COINBASE_EXCHANGE_API ?? "https://api.exchange.coinbase.com";
const COINGECKO_API = process.env.COINGECKO_API ?? "https://api.coingecko.com";
const BLOCKSCOUT = process.env.BLOCKSCOUT ?? "https://base.blockscout.com";
const USDC_CONTRACT =
  process.env.USDC_CONTRACT ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MARKET_FEED_API_KEY = process.env.MARKET_FEED_API_KEY ?? "";
const MARKET_CACHE_TTL_SECONDS = Number(process.env.MARKET_CACHE_TTL_SECONDS ?? "900");
const MARKET_SNAPSHOT_CACHE_TTL_SECONDS = Number(
  process.env.MARKET_SNAPSHOT_CACHE_TTL_SECONDS ?? "60",
);
const PYRIMID_AFFILIATE_ID =
  process.env.PYRIMID_AFFILIATE_ID ?? "agent-commerce-desk";
const PYRIMID_CATALOG_URL =
  process.env.PYRIMID_CATALOG_URL ?? "https://pyrimid.ai/api/v1/catalog";
const PYRIMID_DEFAULT_MAX_PRICE_ATOMIC = Number(
  process.env.PYRIMID_DEFAULT_MAX_PRICE_ATOMIC ?? "1000000",
);
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://facilitator.world.fun";
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MARKET_ALLOWED_PAIRS = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);
const MARKET_CACHE = new Map();

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
  version: "0.7.1",
  description:
    "Checks whether a Base wallet is safe to publish as a USDC receiving wallet, then sells fixed-price agent payment, VPS, wallet-risk, and QA implementation work.",
  payTo: PAY_TO,
  acceptedPayment: {
    asset: "native USDC",
    assetContract: USDC_CONTRACT,
    network: "Base",
    networkCaip2: NETWORK,
    price: PRICE,
    payTo: PAY_TO,
    facilitator: FACILITATOR_URL,
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
      "GET /api/pyrimid/recommend?need=paid%20mcp%20tool",
      "POST /api/pyrimid/recommend",
      "GET /wallet-sign",
    ],
    paid: [
      "GET /api/readiness?address=0x...",
      "GET /api/readiness/:address",
      "GET /api/agent-commerce-receipt?address=0x...",
      "GET /api/agent-commerce-receipt/:address",
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
  ],
  tools: {
    walletSignatureHelper: "/wallet-sign",
    pyrimidRecommendations: "/api/pyrimid/recommend",
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
      facilitator: FACILITATOR_URL,
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
        id: "pyrimid-product-recommendations",
        name: "Pyrimid Product Recommendations",
        description:
          "Official @pyrimid/sdk resolver integration that recommends paid MCP/API products by natural-language need and returns x402 purchase metadata plus affiliate split estimates.",
        uri: "/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3",
        method: "GET",
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
        extensions: {
          bazaar: {
            discoverable: true,
            category: "crypto",
            tags: ["base", "wallet", "usdc", "payment-safety", "agent-payments"],
            info: {
              input: {
                type: "http",
                method: "GET",
                queryParams: {
                  address: SAMPLE_ADDRESS,
                },
              },
              output: readinessBazaarOutput(),
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
                type: "http",
                method: "GET",
                pathParams: {
                  address: SAMPLE_ADDRESS,
                },
              },
              output: readinessBazaarOutput(),
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
                type: "http",
                method: "GET",
                queryParams: {
                  address: SAMPLE_ADDRESS,
                },
              },
              output: receiptBazaarOutput(),
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
                type: "http",
                method: "GET",
                pathParams: {
                  address: SAMPLE_ADDRESS,
                },
              },
              output: receiptBazaarOutput(),
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

function parseSnapshotLimit(rawLimit) {
  const limit = Number(rawLimit || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    const error = new Error("limit must be an integer between 1 and 50");
    error.statusCode = 400;
    throw error;
  }
  return limit;
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

function x402Manifest() {
  return {
    x402Version: 2,
    name: serviceInfo.name,
    description: serviceInfo.description,
    homepage: baseUrl(),
    manifest: `${baseUrl()}/manifest`,
    agentCard: `${baseUrl()}/.well-known/agent-card.json`,
    network: NETWORK,
    facilitator: FACILITATOR_URL,
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
Facilitator: ${FACILITATOR_URL}

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
- GET ${baseUrl()}/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3

## Paid x402 endpoints

- GET ${baseUrl()}/api/readiness/${sampleAddress}
- GET ${baseUrl()}/api/agent-commerce-receipt/${sampleAddress}

Use the x402 manifest for exact payment requirements before calling paid endpoints.
`;
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

function x402Accept() {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: String(Math.round(priceUsd() * 1_000_000)),
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
