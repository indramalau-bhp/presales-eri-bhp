#!/usr/bin/env bash
# Backup database D1 "inventory-aset" ke file SQL bertimestamp (mac/Linux/CI).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
out="backups/inventory-aset-$stamp.sql"
echo "Mengekspor database D1 (produksi) -> $out"
npx wrangler d1 export inventory-aset --remote --output "$out"
echo "Selesai: $out"
