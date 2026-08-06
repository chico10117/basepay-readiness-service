# x402 Preflight

Inspect and validate an unfamiliar x402 endpoint before an autonomous agent
spends USDC.

x402 Preflight performs bounded, read-only HTTPS probes. It observes the live
payment challenge, price, network, asset, receiver, Bazaar discovery metadata,
CORS, redirects, cache behavior, and other operational signals. It never
connects a buyer wallet, forwards payment credentials, signs a payload, or
spends funds.

A report is time-bound evidence, not an endorsement. It cannot prove seller
identity or intent, contract safety, future availability, successful
settlement, or delivery of a business outcome.

## Canonical Capabilities

| Capability | Interface | Access | Use |
| --- | --- | --- | --- |
| `inspect_x402_endpoint` | `POST /api/preflight/inspect` | Free | Inspect an unfamiliar live challenge before payment. |
| `audit_x402_endpoint` | `POST /api/x402/preflight/audit` | x402, `$0.05` default | Deep-check schemas, discovery, CORS, redirects, cache, and policy. |
| `order_x402_remediation` | `POST /api/x402/preflight/remediation` | x402, configurable | Escalate a blocked or risky audit into a durable remediation intake. |

Canonical remediation requires a healthy `ORDER_DATABASE_URL`. If durable
storage is unavailable, HTTP and MCP calls fail with
`REMEDIATION_UNAVAILABLE` before a payment challenge is served.

These are the only primary operations in OpenAPI, MCP, `llms.txt`, the
manifest, and agent metadata. Existing wallet, market, weather, repository,
marketplace, and helper routes remain available under the manifest's
`labs` section.

## Local Development

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

The API listens on `http://localhost:4021` by default. The service does not
auto-load `.env`; export variables through your process manager or shell.

Useful checks:

```sh
npm run check
npm test
npm run validate:bazaar
npm run verify:discovery
npm run metrics:summary
```

## HTTP and OpenAPI

Free inspection:

```sh
curl -sS http://localhost:4021/api/preflight/inspect \
  -H 'content-type: application/json' \
  --data '{
    "resource_url": "https://example.com/api/resource",
    "method": "GET",
    "expected_network": "eip155:8453",
    "max_price_usd": 1
  }'
```

The same input sent to the paid audit returns HTTP `402` until a client
supplies a valid x402 payment:

```sh
curl -i http://localhost:4021/api/x402/preflight/audit \
  -H 'content-type: application/json' \
  --data '{
    "resource_url": "https://example.com/api/resource",
    "method": "GET",
    "expected_network": "eip155:8453",
    "max_price_usd": 1
  }'
```

The runtime `402` response is authoritative for amount, network, asset,
`payTo`, and Bazaar extensions. The static contract is available at
`/openapi.json`. Errors use one strict envelope with a machine code,
retryability, optional delay, and request ID.

## Remote MCP

The stateless Streamable HTTP endpoint is:

```text
https://x402-wallet-readiness-service.vercel.app/mcp
```

Discover tools without payment:

```sh
curl -sS http://localhost:4021/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`tools/list` returns exactly the three canonical tools and strict input/output
schemas. A paid `tools/call` receives an x402 challenge before tool execution.
The buyer's MCP client remains responsible for explicit payment authorization;
the server never signs or spends automatically.

This service does not implement A2A. `/.well-known/agent-card.json` returns a
clear `A2A_NOT_IMPLEMENTED` response and points clients to MCP, OpenAPI, and
x402 metadata.

Registry-ready remote-server metadata lives in [server.json](./server.json).
It is intentionally not published automatically.

## Discovery and Bazaar

Primary discovery surfaces:

```text
GET /manifest
GET /openapi.json
GET /llms.txt
GET /.well-known/agent.json
GET /.well-known/x402.json
POST /mcp  (initialize, tools/list, tools/call)
```

The x402 resource server registers the Bazaar extension and publishes strict
HTTP and MCP declarations for audit and remediation, including schemas and
examples.

Use CDP Facilitator in production:

```sh
X402_USE_CDP_FACILITATOR=true
CDP_API_KEY_ID=<configured outside git>
CDP_API_KEY_SECRET=<configured outside git>
```

To keep a non-CDP facilitator, leave `X402_USE_CDP_FACILITATOR=false` and set
`X402_FACILITATOR_URL`. `npm run validate:bazaar` validates local Bazaar
declarations. When `PUBLIC_URL` is exported, it also inspects the public
unpaid challenge and queries CDP's read-only merchant catalog for the configured
receiver. Bazaar catalog indexing still requires a successful settlement
through CDP; validation alone does not publish a listing.

## URL Safety

Inspection accepts public HTTPS URLs only. It rejects credentials and sensitive
query parameters, localhost, private/link-local/reserved addresses, metadata
hosts, nonstandard ports, and unsafe redirects before a paid challenge is
created. DNS is checked on the target and every redirect. Requests have bounded
timeouts, response bytes, and redirect counts; JavaScript and target code are
never executed.

Do not submit private keys, seed phrases, access tokens, authorization headers,
cookies, payment signatures, or confidential repository URLs.

## Runtime and Metrics

`GET /health` reports the public service version, commit, deployment time,
network, facilitator mode, database availability, worker heartbeat, and
settlement reconciler status. It does not expose wallets, orders, transaction
hashes, URLs, secrets, or filesystem paths. Every response includes:

```text
X-Service-Version
X-Commit-SHA
X-Request-ID
```

Telemetry is allowlisted, structured JSON and fail-open. Buyer addresses are
recorded only as SHA-256 hashes when `TELEMETRY_BUYER_PEPPER` is configured.
Apply [002_preflight_telemetry.sql](./ops/order-db/migrations/002_preflight_telemetry.sql)
to an existing PostgreSQL installation, then use `npm run metrics:summary`
for 7-day and 30-day aggregates.

Deployment stamping, public smoke checks, database migration, CDP activation,
and MCP Registry preparation are documented in
[docs/OPERATIONS.md](./docs/OPERATIONS.md).

## Labs and Compatibility

Legacy routes have not been deleted and their existing prices remain
unchanged. Representative surfaces include:

- `/api/preview`, `/api/readiness`, and `/api/agent-commerce-receipt`
- `/api/market/*`, `/api/x402/market/*`, and `/api/weather/current`
- `/api/dev/repo-snapshot` and `/api/x402/dev/repo-snapshot`
- `/api/x402/services/quick-review` and
  `/api/x402/services/integration-triage`
- marketplace webhooks, `/wallet-sign`, and `/open-frame`

No sunset date is announced. The historical custom metadata documents remain
at `/labs/legacy-agent.json` and `/labs/legacy-agent-card.json` with a
`Deprecation: true` response header.
