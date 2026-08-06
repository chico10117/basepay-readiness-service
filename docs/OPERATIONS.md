# x402 Preflight Operations

These steps are intentionally manual. They do not spend USDC, deploy code,
restart production, or publish registry metadata by themselves.

## Stamp a VPS Runtime

From the checked-out release:

```sh
release_version="$(node -p "require('./package.json').version")"
release_commit="$(git rev-parse HEAD)"
release_deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

sudo install -d -m 0750 /etc/x402-wallet-readiness
printf 'SERVICE_VERSION=%s\nGIT_COMMIT_SHA=%s\nDEPLOYED_AT=%s\n' \
  "$release_version" "$release_commit" "$release_deployed_at" |
  sudo tee /etc/x402-wallet-readiness/runtime.env >/dev/null
sudo chmod 0600 /etc/x402-wallet-readiness/runtime.env
```

After copying the updated unit files and application, an operator may run:

```sh
sudo systemctl daemon-reload
sudo systemctl restart x402-wallet-readiness.service
sudo systemctl restart x402-review-worker.service
```

Verify the exact release after the public proxy reaches the VPS:

```sh
PUBLIC_URL=https://x402-wallet-readiness-service.vercel.app \
SERVICE_VERSION="$release_version" \
GIT_COMMIT_SHA="$release_commit" \
npm run verify:runtime
```

## Configure Vercel

Set the same `SERVICE_VERSION`, `GIT_COMMIT_SHA`, and RFC 3339
`DEPLOYED_AT` values in the production environment if Vercel runs the Node
process. In the current rewrite topology, the VPS response headers and
`/health` body remain authoritative. Do not put CDP secrets in
`vercel.json`.

Run the no-payment public checks only after deployment:

```sh
PUBLIC_URL=https://x402-wallet-readiness-service.vercel.app \
SERVICE_VERSION="$release_version" \
GIT_COMMIT_SHA="$release_commit" \
npm run smoke:public
```

The smoke command fetches metadata, calls the free inspector, and verifies an
unpaid audit challenge. It never creates a payment authorization.

## Apply the Optional Metrics Migration

The application creates missing tables idempotently at startup. Existing
installations can apply the explicit migration before restart:

```sh
psql "$ORDER_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f ops/order-db/migrations/002_preflight_telemetry.sql
```

`ORDER_DATABASE_URL` is optional for inspection and audit, but canonical
remediation requires it to be configured and healthy. The service returns
`REMEDIATION_UNAVAILABLE` before presenting a payment challenge otherwise.
Set `ORDER_STORE_REQUIRED=true` in production deployments that promise the
remediation capability.

Set a new high-entropy pepper only in the service environment:

```text
TELEMETRY_ENABLED=true
TELEMETRY_DATABASE_ENABLED=true
TELEMETRY_BUYER_PEPPER=<secret value outside git>
```

Changing the pepper changes buyer pseudonyms and breaks cross-period repeat
buyer comparison. Raw buyer wallets are never written to telemetry.

## Enable CDP Facilitator

Place these values in the VPS-only service environment, such as
`/etc/x402-wallet-readiness/order-store.env`:

```text
X402_USE_CDP_FACILITATOR=true
CDP_API_KEY_ID=<CDP key ID>
CDP_API_KEY_SECRET=<CDP key secret>
```

Then validate before any real purchase:

```sh
npm run validate:bazaar
npm run verify:discovery
```

With `PUBLIC_URL` exported, both commands inspect the public unpaid challenge;
they do not settle or pay it. `validate:bazaar` also performs a read-only lookup
against CDP's official merchant discovery endpoint and reports whether the
canonical audit URL is already indexed. A Bazaar catalog entry appears only
after a successful CDP-facilitated settlement. That production settlement is
a separate, explicitly authorized manual action.

## Prepare MCP Registry Publication

1. Deploy and verify public HTTPS `POST /mcp`.
2. Confirm `server.json` names the final stable remote URL and release version.
3. Validate with the current official `mcp-publisher` CLI.
4. Authenticate and publish manually under the repository owner's namespace.

Do not publish until the domain, repository ownership, and remote MCP endpoint
are stable. This repository does not automate registry authentication or
publication.

## Rollback and Diagnosis

Keep the previous application release available. Before rollback, compare:

```sh
curl -sS https://x402-wallet-readiness-service.vercel.app/health
systemctl status x402-wallet-readiness.service --no-pager
journalctl -u x402-wallet-readiness.service -n 100 --no-pager
```

If `version` or `commitSha` differs from the intended release, correct the
runtime environment or deployment target before debugging application logic.
