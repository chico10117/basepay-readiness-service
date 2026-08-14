#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root so wallet recovery material remains private" >&2
  exit 1
fi

for command_name in base64 curl docker jq; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "missing required command: ${command_name}" >&2
    exit 1
  fi
done

lnd_config_dir="/etc/l402-lnd"
lnd_data_dir="/var/lib/l402-lnd"
aperture_lnd_dir="/etc/l402-aperture/lnd"
wallet_password_file="${lnd_config_dir}/wallet-password"
recovery_seed_file="${lnd_config_dir}/recovery-seed.txt"
lnd_tls_cert="${lnd_data_dir}/tls.cert"
lnd_invoice_macaroon="${lnd_data_dir}/data/chain/bitcoin/mainnet/invoice.macaroon"
lnd_wallet_db="${lnd_data_dir}/data/chain/bitcoin/mainnet/wallet.db"
lnd_rest_url="https://127.0.0.1:18080"

if [[ ! -s "${wallet_password_file}" ]]; then
  echo "run install-lnd.sh before bootstrapping the wallet" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx 'l402-lnd'; then
  echo "start the LND container before bootstrapping the wallet" >&2
  exit 1
fi

for _ in {1..60}; do
  if [[ -s "${lnd_tls_cert}" ]] &&
    curl --silent --show-error --fail \
      --cacert "${lnd_tls_cert}" \
      "${lnd_rest_url}/v1/state" >/dev/null; then
    break
  fi
  sleep 2
done

if [[ ! -s "${lnd_tls_cert}" ]]; then
  echo "LND did not create its TLS certificate" >&2
  exit 1
fi

if [[ ! -s "${lnd_wallet_db}" ]]; then
  seed_response="$(mktemp)"
  init_request="$(mktemp)"
  init_response="$(mktemp)"
  trap 'rm -f "${seed_response}" "${init_request}" "${init_response}"' EXIT

  if [[ -s "${recovery_seed_file}" ]]; then
    jq -n --rawfile seed "${recovery_seed_file}" \
      '{cipher_seed_mnemonic: [$seed | scan("[a-z]+")]} ' \
      > "${seed_response}"
  else
    curl --silent --show-error --fail \
      --cacert "${lnd_tls_cert}" \
      "${lnd_rest_url}/v1/genseed" > "${seed_response}"
    jq -e '.cipher_seed_mnemonic | length == 24' \
      "${seed_response}" >/dev/null
    jq -r '.cipher_seed_mnemonic | join(" ")' \
      "${seed_response}" > "${recovery_seed_file}"
    chmod 0600 "${recovery_seed_file}"
  fi

  jq -e '.cipher_seed_mnemonic | length == 24' \
    "${seed_response}" >/dev/null

  wallet_password_b64="$(base64 -w 0 < "${wallet_password_file}")"
  jq --arg wallet_password "${wallet_password_b64}" \
    --slurpfile seed "${seed_response}" \
    '{
      wallet_password: $wallet_password,
      cipher_seed_mnemonic: $seed[0].cipher_seed_mnemonic
    }' > "${init_request}"

  curl --silent --show-error --fail \
    --cacert "${lnd_tls_cert}" \
    -H 'Content-Type: application/json' \
    --data-binary "@${init_request}" \
    "${lnd_rest_url}/v1/initwallet" > "${init_response}"
fi

for _ in {1..90}; do
  if [[ -s "${lnd_invoice_macaroon}" ]]; then
    break
  fi
  sleep 2
done

if [[ ! -s "${lnd_invoice_macaroon}" ]]; then
  echo "LND did not create its invoice macaroon" >&2
  exit 1
fi

install -d -m 0700 "${aperture_lnd_dir}/mainnet"
install -m 0444 "${lnd_tls_cert}" "${aperture_lnd_dir}/tls.cert"
install -m 0400 \
  "${lnd_invoice_macaroon}" \
  "${aperture_lnd_dir}/mainnet/invoice.macaroon"

echo "LND wallet initialized and invoice-only Aperture credentials exported"
if [[ -s "${recovery_seed_file}" ]]; then
  echo "BACK UP ${recovery_seed_file} OFF THE VPS BEFORE FUNDING THE NODE"
else
  echo "verify the existing wallet recovery backup before funding the node"
fi
echo "the recovery seed was not displayed"
