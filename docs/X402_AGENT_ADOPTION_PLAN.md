# x402 Agent Adoption Plan

## Objective

Reposition the public product as **x402 Preflight**: a read-only service that lets an agent inspect an unfamiliar x402 resource before deciding whether to spend USDC. The public discovery contract will expose exactly three primary capabilities:

1. `inspect_x402_endpoint` — free, shallow preflight.
2. `audit_x402_endpoint` — $0.05-by-default x402-gated deep audit.
3. `order_x402_remediation` — paid escalation into the existing durable review workflow.

Existing wallet, market, weather, repository, marketplace, signing-helper, and webhook routes remain operational. They move to explicit `labs`/`legacy` metadata and no longer dominate the landing page, OpenAPI, manifest, `llms.txt`, or MCP tool list.

## Baseline (2026-08-05)

- Worktree was clean before implementation.
- `npm install`: dependencies already current within the lockfile; npm reported 7 known vulnerabilities (1 low, 1 moderate, 5 high). No broad dependency upgrade is included in this scope.
- `npm run check`: passed.
- `npm test`: 12 passed, 1 PostgreSQL integration test skipped because `TEST_ORDER_DATABASE_URL` was unset.
- Runtime is Node.js ESM/Express with x402 Foundation packages at `2.13.0` and `@coinbase/x402` at `2.1.0`.

## Verified Protocol Decisions

- Use the installed `bazaarResourceServerExtension` and `declareDiscoveryExtension()` APIs; do not invent extension fields.
- CDP mode continues through `@coinbase/x402` and its official facilitator URL. Alternative `X402_FACILITATOR_URL` mode remains supported.
- Runtime `402` requirements remain authoritative for amount, network, asset, and receiver. Static documents describe configured intent and verification scripts detect drift.
- Bazaar indexing cannot be proven without a successful CDP settlement. Local/public validation will validate extension schemas and inspect an unpaid challenge, but will never make a payment.
- `/mcp` implements stateless Streamable HTTP JSON responses for MCP protocol `2025-11-25`, while negotiating `2025-06-18` and the required `2025-03-26` no-header fallback. `GET /mcp` returns `405` because server-initiated SSE is not offered. Invalid browser origins return `403`.
- `/.well-known/agent-card.json` will explicitly state that A2A is not implemented instead of publishing a custom structure under an A2A-standard path.

## Group 1 — Product and Agent Contract

1. Extract strict request/report/error JSON Schemas into `src/preflight/`.
2. Build a secure URL probe that reuses the existing SSRF policy, requires HTTPS, validates DNS before each request and redirect, caps redirects/time/bytes, and sends no credentials or payment headers.
3. Parse x402 v1/v2 challenge shapes without assuming undocumented fields. Normalize observable requirements and keep unknown values explicit.
4. Implement deterministic checks, `ALLOW|CAUTION|BLOCK|UNKNOWN` decisions, prioritized issues, report TTL, and claim boundaries.
5. Add free `POST /api/preflight/inspect` and paid `POST /api/x402/preflight/audit` routes. Validate blocked/invalid targets before payment middleware.
6. Add `POST /api/x402/preflight/remediation` as the canonical alias into the existing integration-triage/order-store/review-worker path.
7. Replace primary landing/discovery copy with x402 Preflight and preserve old routes as labs.

## Group 2 — Bazaar and MCP Discovery

1. Explicitly register the Bazaar resource-server extension.
2. Attach complete input/output schema, example, description, MIME type, and service metadata to the paid audit route and paid MCP calls.
3. Implement `/mcp` with exactly three tools. Tool listing is free; paid audit/remediation calls pass through conditional x402 middleware. The server never signs or pays for a client.
4. Add `server.json` for later remote MCP Registry publication; do not publish or authenticate.
5. Add `validate:bazaar` and `verify:discovery` scripts. Public mode inspects unpaid `402` responses only.

## Group 3 — Runtime Trust and Commercial Telemetry

1. Add request IDs and `X-Service-Version`, `X-Commit-SHA`, and `X-Request-ID` headers globally.
2. Expand `/health` with version/deployment identity and aggregate database, worker-heartbeat, and settlement-reconciler status. No order/payment identifiers or secrets are returned.
3. Add fail-open structured telemetry with a strict field allowlist. Buyer identifiers are emitted only as a peppered hash.
4. Add optional PostgreSQL tables for telemetry events and component heartbeats, plus 7/30-day aggregate reporting.
5. Emit lifecycle events at discovery, MCP listing, inspection, challenge, verification, settlement, remediation, and delivery boundaries.
6. Add `smoke:public` and `verify:runtime`; both are read-only and never supply a payment header.
7. Pass version/deployment environment through systemd examples and document safe manual deployment/CDP/MCP publication steps.

## Validation Strategy

- Unit tests: input schemas, challenge decoding, decision outcomes, timeout, private URL, unsafe redirect, malformed challenge, Bazaar schema, MCP listing/origin/paid-call routing, telemetry redaction, and metrics empty state.
- HTTP integration tests: free inspect and MCP discovery using local fixture servers plus injected DNS/fetch adapters where public HTTPS is impractical.
- Final commands: `npm run check`, `npm test`, and `npm run verify:discovery`. Run `npm run smoke:public` only when an explicit `PUBLIC_URL` is present.

## Final Implementation Status (2026-08-06)

- Groups 1–3 are implemented; legacy route paths and prices remain in place.
- `npm run check`: passed.
- `npm test`: 39 passed, 0 failed, 1 PostgreSQL integration test skipped because `TEST_ORDER_DATABASE_URL` was unset.
- `npm run verify:discovery`: passed in local-contract mode with exactly three canonical capabilities.
- `npm run validate:bazaar`: all four HTTP/MCP audit/remediation declarations passed the official package validator.
- `npm run metrics:summary`: passed with the documented empty-state output while PostgreSQL was unconfigured.
- `npm run smoke:public` and `npm run verify:runtime` were not run because `PUBLIC_URL` was not present in the execution environment.

## Known Boundaries

- A preflight report proves only what was observed over HTTPS at a point in time; it cannot prove future availability, seller intent, contract safety, or that a later payment will settle.
- DNS validation reduces SSRF risk but cannot eliminate every DNS rebinding race in Node's default fetch implementation. Redirects are revalidated and private/link-local/metadata destinations are blocked.
- A configured `POST` inspection sends an empty JSON object to observe the method-specific challenge. The service sends no buyer credential, but cannot guarantee that a third-party target treats an unauthenticated POST as side-effect free.
- Canonical remediation intentionally returns `REMEDIATION_UNAVAILABLE` before payment when its PostgreSQL order store is not healthy.
- Bazaar catalog presence requires a real successful settlement through CDP and remains a post-deployment manual verification.
- No A2A server, wallet signing, automatic spending, deployment, process restart, or registry publication is included.
