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
```

Default price:

```text
$2
```

Default receiving wallet:

```text
0xb19262185bac9748e2b71674Ef48676448F7A516
```

The endpoint checks:

- Base ETH balance
- Native USDC balance
- Transaction count
- Token transfer count
- Contract-vs-EOA status
- Blockscout reputation and token visibility

## Local Testnet Run

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
```

## Production Mainnet Settings

To accept real USDC on Base through CDP's facilitator:

```sh
export X402_NETWORK=eip155:8453
export X402_USE_CDP_FACILITATOR=true
export CDP_API_KEY_ID=...
export CDP_API_KEY_SECRET=...
export PAY_TO=0xb19262185bac9748e2b71674Ef48676448F7A516
export X402_PRICE='$2'
npm start
```

Do not commit CDP credentials.

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
