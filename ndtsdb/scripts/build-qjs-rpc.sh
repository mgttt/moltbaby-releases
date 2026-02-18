#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

SRC="docs/poc/qjs-ndtsdb-rpc.c"
OUT="docs/poc/qjs-ndtsdb-rpc"
CFLAGS=(
  -std=c11
  -O2
  -Wall
  -D_GNU_SOURCE
)

# ndtsdb.c 包含 libndtsDB 与高级 API 的实现

gcc "${CFLAGS[@]}" -I"native" -o "$OUT" "$SRC" "native/ndts.c" -lm

echo "built: $OUT"
