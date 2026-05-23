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
```

Endpoint:

```text
GET /api/readiness?address=0x...
GET /api/readiness/:address
GET /api/agent-commerce-receipt?address=0x...
GET /api/agent-commerce-receipt/:address
GET /api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365
GET /api/market/crypto-snapshot?limit=50
POST /api/market/ohlcv
POST /api/market/crypto-snapshot
GET /wallet-sign
```

Default price:

```text
$2
```

Default receiving wallet:

```text
0xb19262185bac9748e2b71674Ef48676448F7A516
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

The wallet signer at `/wallet-sign` is a client-side helper for producing
`personal_sign` or `eth_signTypedData_v4` payloads from the published Base
receiving wallet. It does not post messages or signatures back to the server.

## Local Run

```sh
npm install
npm start
```

Without a payment header, the paid endpoint should return HTTP 402:

```sh
curl -i 'http://localhost:4021/api/readiness?address=0xb19262185bac9748e2b71674Ef48676448F7A516'
```

Free metadata:

```sh
curl http://localhost:4021/manifest
curl http://localhost:4021/.well-known/agent-card.json
curl http://localhost:4021/.well-known/agent.json
curl http://localhost:4021/api/800402/preview
curl 'http://localhost:4021/api/market/ohlcv?pairs=BTC-USD,ETH-USD&days=30'
curl 'http://localhost:4021/api/market/crypto-snapshot?limit=50'
curl -X POST http://localhost:4021/api/market/crypto-snapshot \
  -H 'content-type: application/json' \
  -d '{"limit": 3}'
```

The `agent-commerce-receipt` endpoint is the 800402 demo surface. It combines
ERC-8004-style agent metadata, x402 Base USDC payment terms, and the Base
wallet-readiness evidence in one paid JSON receipt.

## Production Mainnet Settings

To accept real USDC on Base:

```sh
export X402_NETWORK=eip155:8453
export X402_FACILITATOR_URL=https://facilitator.world.fun
export PAY_TO=0xb19262185bac9748e2b71674Ef48676448F7A516
export X402_PRICE='$2'
npm start
```

To use Coinbase CDP's facilitator instead, set `X402_USE_CDP_FACILITATOR=true`
and provide CDP credentials through environment variables. Do not commit CDP
credentials.

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
