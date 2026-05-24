# Agent Commerce Desk

A deployed offer page plus an x402-ready API proof. The API checks Base wallet
payment readiness; the money offer is fixed-price implementation work paid in
native USDC on Base.

## What It Sells

Primary offers:

```text
$100 Same-day kickoff
$150 Base USDC payment setup
$200 VPS health dashboard
$250 Wallet risk monitor
$300 Agent QA harness
$75 GitHub repo intelligence snapshot
```

Endpoint:

```text
GET /api/readiness?address=0x...
GET /api/readiness/:address
GET /api/preview?address=0x...
GET /api/preview/:address
POST /api/preview
POST /api/preview/:address
GET /api/agent-commerce-receipt?address=0x...
GET /api/agent-commerce-receipt/:address
GET /api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365
GET /api/market/crypto-snapshot?limit=50
POST /api/market/ohlcv
POST /api/market/crypto-snapshot
GET /api/dev/repo-snapshot?repo=owner/name
POST /api/dev/repo-snapshot
GET /api/weather/current?latitude=37.7749&longitude=-122.4194
GET /api/agentmint/weather-current
POST /api/agentmint/weather-current
GET /api/x402/market/crypto-snapshot?limit=50
GET /api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365
GET /api/x402/dev/repo-snapshot?repo=owner/name
GET /api/x402/weather/current?latitude=37.7749&longitude=-122.4194
GET /api/x402/services/integration-triage?repository_or_url=...&goal=...
GET /api/pyrimid/recommend?need=paid%20mcp%20tool
POST /api/pyrimid/recommend
GET /.well-known/the402.json
GET /.well-known/402index-verify.txt
GET /api/the402/services
GET /api/the402/webhook
POST /api/the402/webhook
GET /open-frame
POST /open-frame
GET /open-frame.svg
GET /xmtp-bounty-dm
GET /.well-known/x402
GET /.well-known/x402.json
GET /llms.txt
GET /wallet-sign
```

Default price:

```text
$2
```

Default receiving wallet:

```text
0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9
```

Default settlement:

```text
Network: Base mainnet (`eip155:8453`)
Asset: native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
Facilitator: https://facilitator.world.fun
```

The endpoint checks:

- Base ETH balance
- Native USDC balance
- Transaction count
- Token transfer count
- Contract-vs-EOA status
- Blockscout reputation and token visibility

The market-data endpoint returns daily OHLCV candles for supported Coinbase
Exchange pairs (`BTC-USD`, `ETH-USD`, `SOL-USD`). It is cache-backed and can be
locked behind `MARKET_FEED_API_KEY` for buyer delivery through `x-api-key` or a
Bearer token.

The crypto snapshot endpoint returns the top crypto assets by market cap using
CoinGecko, plus Coinbase USD bid/ask spread data where a Coinbase product is
available. It is intended as a live proof artifact for buyer testing before
turning on API-key access.

The POST wrappers accept JSON bodies such as `{"limit": 50}` or
`{"pairs": ["BTC-USD", "ETH-USD"], "days": 365}` so marketplace probes can call
the data feeds without query-string construction.

The repo intelligence endpoint returns a public GitHub repository snapshot for
agent scoping: metadata, language mix, recent commits, latest release, root
`package.json` signals, and risk flags. It uses the public GitHub API by default;
set `GITHUB_PUBLIC_API_TOKEN` only if you intentionally want higher public API
rate limits.

Low-price x402 aliases are available for API directories that require direct
402 payment challenges. They keep the free proof endpoints unchanged:

```text
GET /api/x402/market/crypto-snapshot?limit=50  # $0.01
GET /api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365  # $0.02
GET /api/x402/dev/repo-snapshot?repo=vercel/next.js  # $0.05
GET /api/x402/weather/current?latitude=37.7749&longitude=-122.4194  # $0.01
GET /api/x402/services/integration-triage?repository_or_url=...&goal=...  # $100
```

The integration triage endpoint is a fixed-price x402 human-service intake for
Base USDC/x402 endpoint, marketplace listing, webhook, or receipt-verifier
work. It validates `repository_or_url` and `goal` before payment, then returns
a paid order receipt and 24h delivery instructions after a valid x402 payment.

The free wallet preview also accepts POST bodies such as
`{"address":"0x..."}`. POST helpers unwrap AgentMint-style bodies such as
`{"input":{...}}`, keeping marketplace webhook calls usable when the
marketplace invokes a published skill by POST instead of GET.

The Pyrimid recommender uses the official `@pyrimid/sdk` resolver to recommend
paid MCP/API products by natural-language need. It returns the product endpoint,
x402 purchase header, affiliate split estimate, and the target Base USDC payout
wallet, but it does not sign or spend from any wallet.

The the402 provider endpoints expose dashboard/API-ready service definitions
and a webhook receiver:

```text
GET /.well-known/the402.json
GET /api/the402/services
GET /api/the402/webhook
POST /api/the402/webhook
```

After onboarding on the402, set `THE402_WEBHOOK_SECRET` and `THE402_API_KEY`.
The webhook verifies `X-Webhook-Signature` when configured, auto-fulfills the
instant market-data and wallet-readiness services, and accepts manual
implementation triage jobs without storing the target wallet private key.

The wallet signer at `/wallet-sign` is a client-side helper for producing
`personal_sign` or `eth_signTypedData_v4` payloads from the published Base
receiving wallet. It does not post messages or signatures back to the server.
It supports URL prefill parameters for phone workflows:
`/wallet-sign?method=personal_sign&source=BountyBook&challenge=...`.

## Local Run

```sh
npm install
npm start
```

Without a payment header, the paid endpoint should return HTTP 402:

```sh
curl -i 'http://localhost:4021/api/readiness?address=0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9'
curl -i 'http://localhost:4021/api/x402/market/crypto-snapshot?limit=10'
curl -i 'http://localhost:4021/api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=30'
curl -i 'http://localhost:4021/api/x402/dev/repo-snapshot?repo=vercel/next.js'
curl -i 'http://localhost:4021/api/x402/services/integration-triage?repository_or_url=https%3A%2F%2Fgithub.com%2Fexample%2Fproject&goal=Make%20x402%20payment%20challenges%20browser-readable'
```

Free metadata:

```sh
curl http://localhost:4021/manifest
curl http://localhost:4021/.well-known/agent-card.json
curl http://localhost:4021/.well-known/agent.json
curl http://localhost:4021/.well-known/x402
curl http://localhost:4021/.well-known/x402.json
curl http://localhost:4021/llms.txt
curl http://localhost:4021/api/800402/preview
curl 'http://localhost:4021/api/preview?address=0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9'
curl -X POST http://localhost:4021/api/preview \
  -H 'content-type: application/json' \
  -d '{"address":"0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9"}'
curl 'http://localhost:4021/api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=30'
curl 'http://localhost:4021/api/market/crypto-snapshot?limit=50'
curl 'http://localhost:4021/api/dev/repo-snapshot?repo=vercel/next.js'
curl 'http://localhost:4021/api/weather/current?latitude=37.7749&longitude=-122.4194'
curl -X POST http://localhost:4021/api/agentmint/weather-current \
  -H 'content-type: application/json' \
  -d '{"input":{"latitude":37.7749,"longitude":-122.4194,"forecast_days":2}}'
curl -X POST http://localhost:4021/api/market/crypto-snapshot \
  -H 'content-type: application/json' \
  -d '{"limit": 3}'
curl -X POST http://localhost:4021/api/dev/repo-snapshot \
  -H 'content-type: application/json' \
  -d '{"repo": "vercel/next.js"}'
curl 'http://localhost:4021/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3'
curl http://localhost:4021/api/the402/services
curl http://localhost:4021/.well-known/the402.json
curl http://localhost:4021/.well-known/402index-verify.txt
curl http://localhost:4021/open-frame
curl http://localhost:4021/xmtp-bounty-dm
curl -X POST http://localhost:4021/api/the402/webhook \
  -H 'content-type: application/json' \
  -d '{"event":"webhook_test"}'
```

The `/open-frame` endpoint is compatible with the Open Frames metadata
standard. It advertises `of:accepts:xmtp`, `of:accepts:farcaster`, and
`of:accepts:anonymous`, includes Farcaster fallback tags, and links back to the
wallet preview, paid work request, and wallet signer.

The `agent-commerce-receipt` endpoint is the 800402 demo surface. It combines
ERC-8004-style agent metadata, x402 Base USDC payment terms, and the Base
wallet-readiness evidence in one paid JSON receipt.

## Production Mainnet Settings

To accept real USDC on Base:

```sh
export X402_NETWORK=eip155:8453
export X402_FACILITATOR_URL=https://facilitator.world.fun
export PAY_TO=0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9
export X402_PRICE='$2'
npm start
```

To use Coinbase CDP's facilitator instead, set `X402_USE_CDP_FACILITATOR=true`
and provide CDP credentials through environment variables. Do not commit CDP
credentials.

Coinbase Bazaar discovery requires the CDP facilitator to settle at least one
paid call with Bazaar metadata; `.well-known/x402.json` and `/llms.txt` are
public discovery aids, but they do not register the service in Coinbase's
catalog by themselves.

## Marketplace Positioning

List as:

```text
Agent Commerce Desk
```

Category:

```text
crypto / data / payment-safety
```

Short description:

```text
Fixed-price crypto, agent, and VPS automation work paid in native USDC on Base. Live proof includes an x402-ready Base wallet-readiness endpoint that checks ETH, native USDC, transaction count, token transfers, contract status, and visible explorer reputation.
```
