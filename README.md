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
GET /api/tools402/services/integration-triage?repository_or_url=...&goal=...
POST /api/tools402/services/integration-triage
GET /api/agentmint/weather-current
POST /api/agentmint/weather-current
GET /api/x402/market/crypto-snapshot?limit=50
GET /api/x402/market/ohlcv?pairs=BTC-USD,ETH-USD&days=365
GET /api/x402/dev/repo-snapshot?repo=owner/name
GET /api/x402/weather/current?latitude=37.7749&longitude=-122.4194
GET /api/x402/services/integration-triage?repository_or_url=...&goal=...
POST /api/x402/services/integration-triage
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
POST /api/x402/services/integration-triage  # $100
```

The integration triage endpoint is a fixed-price x402 human-service intake for
Base USDC/x402 endpoint, marketplace listing, webhook, or receipt-verifier
work. It accepts either GET query params or a POST JSON body, validates
`repository_or_url` and `goal` before payment, then returns a paid order receipt
and 24h delivery instructions after a valid x402 payment.

The direct x402 Quick Review and Integration Triage routes persist paid-service
intakes in PostgreSQL when `ORDER_DATABASE_URL` is configured. The handler
stores the normalized request after facilitator verification and before it
returns success, so a database failure prevents settlement. After successful
x402 settlement, the resource-server hook first writes a minimal settlement
proof to a local durable journal and then records the payer and transaction
hash in PostgreSQL. If that database write fails, an in-process reconciler
replays the journal every 15 seconds with bounded backoff until the same
idempotent transaction queues the review job. The journal contains only the
order ID, transaction hash, payer, network, amount, and receiver; it never
stores the payment authorization, signature, access token, or private key.
Payment retries are separately deduplicated with a SHA-256 fingerprint of the
authorization, while the authorization itself is never stored.

Successful settlements now create a durable automated-review job. The VPS
worker performs read-only inspection of public GitHub repositories or HTTPS
endpoints, stores a versioned JSON result plus Markdown report, and optionally
sends a signed webhook to the buyer's `callback_url`. The receipt includes a
private bearer token and status/result URLs; the token is returned once and its
hash is stored, never the token itself. Callback URLs must be public HTTPS
endpoints; private, loopback, metadata, and credential-bearing URLs are rejected
before payment and rechecked before delivery. Webhook keys are derived per
order from the VPS-only signing key, and failed deliveries are retried and
reported by the alert timer.

Production runs PostgreSQL privately on the VPS loopback interface. Vercel
continues to be the public HTTPS entrypoint and forwards requests to the VPS;
the database is never exposed to Vercel or the public Internet.
The API service keeps its settlement journal at
`/var/lib/x402-wallet-readiness/settlements` with directory mode `0700` and
file mode `0600`. `GET /health` exposes only aggregate journal health, never
order IDs or transaction hashes. Jobs left in `awaiting_settlement` for more
than one minute trigger the existing review alert timer.

```sh
ORDER_DATABASE_URL=postgresql://x402_orders:password@127.0.0.1:6435/x402_orders
ORDER_STORE_REQUIRED=true
```

To force an immediate journal replay during recovery:

```sh
npm run reconcile:settlements
```

Operational files live under `ops/order-db/`. The included systemd timer makes
a daily `pg_dump` backup and retains 30 days. On the VPS, recent orders can be
reviewed without exposing an admin HTTP endpoint:

```sh
docker exec x402-orders-postgres \
  psql -U x402_orders -d x402_orders \
  -c "SELECT order_id, service, status, repository_or_url, goal, settlement_tx_hash, created_at FROM paid_service_orders ORDER BY created_at DESC LIMIT 20;"
```

The automated worker is configured with `/etc/x402-wallet-readiness/review-worker.env`
and runs as `x402review` through `x402-review-worker.service`. The default
`REVIEW_AGENT_PROVIDER=deterministic` performs evidence-based x402 checks
without executing repository scripts. An OpenAI-compatible adapter can be
enabled later by setting `REVIEW_AGENT_PROVIDER`, `REVIEW_AGENT_API_URL`, and
`REVIEW_AGENT_API_KEY` on the VPS; those values must never be committed. When
the adapter returns usage metadata, the worker records token usage and an
estimated cost using `REVIEW_AGENT_COST_PER_1K_TOKENS_USD`, enforcing the
configured per-service budget.

After a paid receipt, use its bearer token with:

```sh
curl -H "Authorization: Bearer <access-token>" \
  https://x402-wallet-readiness-service.vercel.app/api/x402/orders/<order-id>
curl -H "Authorization: Bearer <access-token>" \
  https://x402-wallet-readiness-service.vercel.app/api/x402/orders/<order-id>/result
curl -H "Authorization: Bearer <access-token>" \
  https://x402-wallet-readiness-service.vercel.app/api/x402/orders/<order-id>/report.md
```

The worker never accepts private keys, cookies, or GitHub tokens in a review
request; private repositories require a future read-only GitHub App flow.

The public root page and Open Frame point buyers directly at the sample
`100 USDC` integration-triage order URL. GitHub issue context remains a
secondary path for non-secret repo details after payment.

Facilitator support is initialized lazily on paid routes. If the facilitator is
temporarily unavailable, paid routes return a controlled `502` instead of
crashing free pages or metadata routes.

`GET /api/tools402/services/integration-triage` and
`POST /api/tools402/services/integration-triage` are normal `200` JSON
upstreams for tools402 proxy listings. The tools402 proxy handles buyer payment
before forwarding the same intake fields to these upstreams.

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
curl -I 'http://localhost:4021/api/x402/services/integration-triage?repository_or_url=https%3A%2F%2Fgithub.com%2Fexample%2Fproject&goal=Make%20x402%20payment%20challenges%20browser-readable'
curl -i 'http://localhost:4021/api/x402/services/integration-triage?repository_or_url=https%3A%2F%2Fgithub.com%2Fexample%2Fproject&goal=Make%20x402%20payment%20challenges%20browser-readable'
curl -i -X POST 'http://localhost:4021/api/x402/services/integration-triage' \
  -H 'Content-Type: application/json' \
  --data '{"repository_or_url":"https://github.com/example/project","goal":"Make x402 payment challenges browser-readable"}'
```

### One-shot 2 USDC production smoke test

`npm run test:x402-trigger` watches for one exact native Base USDC transfer:

- sender: `0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9`
- recipient: `0x98aA548A9cE3Ed957657E62B73cD44543FD5ac22`
- amount: `2.000000 USDC`

After three Base confirmations it uses the recipient's local AgentCash signer
to call the `$2` readiness endpoint. Before signing, it rejects any challenge
whose network, token, amount, or `payTo` differs from the values above. Its
private state is stored with mode `0600` outside the repository at
`~/.agentcash/x402-2usdc-trigger.json`; the private key and payment
authorization are never printed. A filesystem lock, persistent authorization,
and on-chain outgoing-transfer check make the trigger one-shot and prevent a
second payment after a retry or process restart.

This smoke test proves the production x402 payment rail. It does not replace
the separate `50 USDC` Quick Review order gate.

The one-shot completed successfully on 2026-08-05:

- funding transaction:
  [`0x9c70...fc75`](https://basescan.org/tx/0x9c70b82d87f8004d5c0d26d613be83e8ee1b65c3dbf7e9100a44dd1a88a5fc75)
- x402 settlement:
  [`0x9d1e...6baa`](https://basescan.org/tx/0x9d1e5a373697b5caca850d5dd4d01390b7fdc649d5ee96c1ce00a0d9473f6baa)
- paid response: HTTP `200`
- replay check: `alreadyCompleted`, with exactly one outgoing `2 USDC`
  transfer from the payer wallet

The persisted completion state contains no payment authorization. Re-running
the command returns the recorded proof without signing or paying again.

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
