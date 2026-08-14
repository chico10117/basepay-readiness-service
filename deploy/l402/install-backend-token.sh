#!/usr/bin/env bash

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root so the token can be installed with restricted permissions" >&2
  exit 1
fi

token_dir="/etc/l402-aperture"
token_file="${token_dir}/backend-token"
backend_env="/etc/x402-wallet-readiness/order-store.env"

install -d -m 0700 "${token_dir}"
install -d -m 0750 "$(dirname "${backend_env}")"

if [[ ! -s "${token_file}" ]]; then
  umask 077
  openssl rand -hex 32 > "${token_file}"
fi
chmod 0600 "${token_file}"

token="$(tr -d '\r\n' < "${token_file}")"
if [[ ! "${token}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "backend token must contain exactly 64 lowercase hexadecimal characters" >&2
  exit 1
fi

temporary_env="$(mktemp "${backend_env}.XXXXXX")"
trap 'rm -f "${temporary_env}"' EXIT

if [[ -f "${backend_env}" ]]; then
  awk '!/^L402_BACKEND_TOKEN=/' "${backend_env}" > "${temporary_env}"
fi
printf 'L402_BACKEND_TOKEN=%s\n' "${token}" >> "${temporary_env}"
install -m 0600 "${temporary_env}" "${backend_env}"

echo "installed the shared L402 backend token without displaying it"
