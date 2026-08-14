# L402 Seller Deployment

This deployment exposes one paid Bitcoin Lightning resource:

```text
https://l402.chikocorp.com/api/l402/repo-opportunity-scan
```

The public Aperture gateway charges `50 sats` for a five-minute L402 access
caveat. Its per-token rate limit refills only after ten minutes, so a valid
credential can authorize one scan before it expires. This makes the advertised
price effectively per report. Free discovery is available at
`/.well-known/l402.json`.

## Architecture

```text
buyer -> Traefik TLS -> Aperture L402 -> private gateway header -> Node API
                              |
                              `-> invoice-only credential -> private LND
```

The Node route fails closed when `L402_BACKEND_TOKEN` is absent. Direct calls
to the backend cannot bypass Aperture because only the gateway knows that
token. Aperture receives an invoice-only macaroon, never `admin.macaroon`.
The Node backend also applies a global authenticated-request cap to limit the
damage from an accidentally disclosed gateway token. Rotate the token and
restart both services after any suspected disclosure.

## One-time backend setup

On the VPS, install one random shared token without printing it:

```sh
sudo ./deploy/l402/install-backend-token.sh
sudo systemctl restart x402-wallet-readiness.service
```

Confirm that a direct backend request remains unavailable:

```sh
curl -i 'http://127.0.0.1:4021/api/l402/repo-opportunity-scan?repo=lightninglabs/aperture'
```

Expected result: `401` when the token is installed, or `503` before setup.

If `GITHUB_PUBLIC_API_TOKEN` is configured, use a credential that cannot read
private repositories and grants only the public metadata permissions required
by the three read-only REST calls. The route deliberately maps any accidentally
visible private repository back to the same `404` shape as a missing repo.

## Install the private LND receiver

Aperture needs an invoice backend before it can issue a real L402 challenge.
The selected production path is LND `v0.21.1-beta` with a Neutrino light
client. The Compose stack publishes Lightning peer traffic on `9735`, but binds
LND RPC and REST to host loopback only. Aperture reaches gRPC over the private
`l402_internal` network.

Install the configuration and a random wallet password without displaying it,
then start only LND:

```sh
sudo ./deploy/l402/install-lnd.sh
docker compose -f deploy/l402/docker-compose.yml up -d lnd
sudo ./deploy/l402/bootstrap-lnd-wallet.sh
```

The bootstrap script creates a new mainnet wallet only when one does not
already exist. It saves the 24 recovery words to the root-only file below and
never displays them in command output:

```text
/etc/l402-lnd/recovery-seed.txt
```

Before sending any bitcoin to the node, the operator must view that file in a
private terminal, make and verify an offline backup, and protect it like a
private key. Never copy the seed, wallet password, wallet database, or an admin
macaroon into this repository or a Codex conversation. The script exports only
`tls.cert` and LND's invoice macaroon into:

```text
/etc/l402-aperture/lnd/tls.cert
/etc/l402-aperture/lnd/mainnet/invoice.macaroon
```

Confirm the node is running and synced before acquiring liquidity:

```sh
docker exec l402-lnd lncli --network=mainnet getinfo
docker exec l402-lnd lncli --network=mainnet walletbalance
docker exec l402-lnd lncli --network=mainnet listchannels
```

The seller must have inbound Lightning capacity before buyers can settle the
invoices. Opening a channel from this node initially creates outbound capacity,
not inbound capacity. Obtain an inbound channel, buy inbound capacity, or fund
and then Loop Out before considering the service payable. Back up LND's static
channel backup after opening a channel.

Wavelength is not the default production path yet: its public mainnet is
allowlisted and its documentation says there is no open public mainnet
deployment. It remains a future way to remove channel management.

## Start the gateway

The VPS already provides the external `traefik_proxy` network and DNS for
`l402.chikocorp.com`.

```sh
sudo install -d -m 0700 /var/lib/l402-aperture
docker compose -f deploy/l402/docker-compose.yml config
docker compose -f deploy/l402/docker-compose.yml up -d aperture
```

The Compose file pins LND `v0.21.1-beta` and Aperture `v0.5.0`, terminates public
TLS at Traefik, and keeps the generated Aperture configuration in
`/var/lib/l402-aperture`. Startup rejects malformed tokens and prices outside
`1..100000` sats instead of silently charging a fallback amount.

## Verify without paying

```sh
curl -sS https://l402.chikocorp.com/.well-known/l402.json
curl -i 'https://l402.chikocorp.com/api/l402/repo-opportunity-scan?repo=lightninglabs/aperture'
lnget --no-pay --json \
  'https://l402.chikocorp.com/api/l402/repo-opportunity-scan?repo=lightninglabs/aperture'
```

The paid resource must answer `402` with an L402 challenge and a `50 sat`
invoice. The metadata and health routes must remain free.

## Paid smoke test

Use a separate low-balance buyer wallet and an explicit cap:

```sh
lnget --max-cost 50 \
  'https://l402.chikocorp.com/api/l402/repo-opportunity-scan?repo=lightninglabs/aperture&limit=5'
```

After settlement, verify the seller invoice and Aperture transaction state.
Do not count the test as earnings if the buyer wallet is also controlled by
the seller.
