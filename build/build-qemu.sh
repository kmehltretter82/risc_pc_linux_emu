#!/usr/bin/env bash
# Build the qemu submodule (branch armv4-boards) to WebAssembly.
# Configure options mirror .gitlab-ci.d job build-wasm64-32bit: wasm64
# objects with a 32-bit address limit, which suits a 32-bit ARM guest.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
QEMU_SRC="$(cd "$HERE/../qemu" && pwd)"
OUT="$HERE/out"

# Link flags beyond the dependency ones: upstream only ever *builds* the wasm
# binary in CI, it never runs it, so nothing there makes the module loadable
# from JS. FS/NODEFS let a node wrapper mount host files for Milestone A and
# let the browser write fetched images into MEMFS; callMain lets the page
# start QEMU with its own argv.
export LDFLAGS="$LDFLAGS \
-sFORCE_FILESYSTEM=1 \
-sEXPORTED_RUNTIME_METHODS=FS,NODEFS,callMain,ccall,cwrap,TTY,ENV \
-sALLOW_MEMORY_GROWTH=1 \
-sENVIRONMENT=web,worker,node \
-sASYNCIFY_STACK_SIZE=131072"

mkdir -p "$OUT"
cd "$OUT"

if [ ! -e config-host.mak ]; then
    emconfigure "$QEMU_SRC/configure" --disable-docs \
        --target-list=arm-softmmu \
        --static --cpu=wasm64 --wasm64-32bit-address-limit \
        --disable-tools --enable-tcg-interpreter \
        --without-default-features \
        --enable-system \
        || { cat meson-logs/meson-log.txt 2>/dev/null | tail -40; exit 1; }
fi

emmake make -j"$(nproc)"
echo "=== artifacts:"
ls -lh qemu-system-arm* 2>/dev/null || true
