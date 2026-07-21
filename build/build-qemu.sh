#!/usr/bin/env bash
# Build the qemu submodule (branch armv4-boards) to WebAssembly.
# Mirrors .gitlab-ci.d job build-wasm64-32bit: wasm64 objects lowered to a
# 32-bit address limit — right for a 32-bit ARM guest.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
QEMU_SRC="$(cd "$HERE/../qemu" && pwd)"
OUT="$HERE/out"
mkdir -p "$OUT"
cd "$OUT"

if [ ! -e config-host.mak ]; then
    emconfigure "$QEMU_SRC/configure" --disable-docs \
        --target-list=arm-softmmu \
        --static --cpu=wasm64 --wasm64-32bit-address-limit \
        --disable-tools --enable-tcg-interpreter
fi
emmake make -j"$(nproc)"
ls -lh qemu-system-arm* 2>/dev/null || true
