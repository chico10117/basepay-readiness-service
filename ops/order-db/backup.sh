#!/bin/sh
set -eu

ORDER_DB_DIR=/opt/x402-order-db
BACKUP_DIR="$ORDER_DB_DIR/backups"

cd "$ORDER_DB_DIR"
set -a
. ./.env
set +a

umask 077
mkdir -p "$BACKUP_DIR"

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary_file=$(mktemp "$BACKUP_DIR/.x402-orders-$timestamp.XXXXXX.sql.gz")
final_file="$BACKUP_DIR/x402-orders-$timestamp.sql.gz"

cleanup() {
  test ! -f "$temporary_file" || rm -f "$temporary_file"
}
trap cleanup EXIT INT TERM

docker compose exec -T postgres \
  pg_dump --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip -9 > "$temporary_file"

mv "$temporary_file" "$final_file"
trap - EXIT INT TERM

find "$BACKUP_DIR" -type f -name 'x402-orders-*.sql.gz' -mtime +30 -delete
