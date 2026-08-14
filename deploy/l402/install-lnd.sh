#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root so LND credentials can be installed privately" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lnd_config_dir="/etc/l402-lnd"
lnd_data_dir="/var/lib/l402-lnd"
aperture_lnd_dir="/etc/l402-aperture/lnd"
wallet_password_file="${lnd_config_dir}/wallet-password"

install -d -m 0700 "${lnd_config_dir}"
install -d -m 0700 "${lnd_data_dir}"
install -d -m 0700 "${aperture_lnd_dir}/mainnet"
install -m 0600 "${script_dir}/lnd.conf" "${lnd_config_dir}/lnd.conf"

if [[ ! -s "${wallet_password_file}" ]]; then
  umask 077
  openssl rand -base64 48 | tr -d '\r\n' > "${wallet_password_file}"
fi

chmod 0600 "${wallet_password_file}"
if [[ "$(wc -c < "${wallet_password_file}")" -lt 32 ]]; then
  echo "LND wallet password is unexpectedly short" >&2
  exit 1
fi

echo "installed the private LND configuration and wallet password"
echo "no wallet or recovery seed was created"
