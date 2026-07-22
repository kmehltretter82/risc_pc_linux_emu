#!/usr/bin/env bash
# Build the qemu submodule (branch armv4-boards) to WebAssembly.
# Configure options mirror .gitlab-ci.d job build-wasm64-32bit: wasm64
# objects with a 32-bit address limit, which suits a 32-bit ARM guest.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
OUT="$HERE/out"

# Link flags beyond the dependency ones: upstream only ever *builds* the wasm
# binary in CI, it never runs it, so nothing there makes the module loadable
# from JS. FS/NODEFS let a node wrapper mount host files for Milestone A and
# let the browser write fetched images into MEMFS; callMain lets the page
# start QEMU with its own argv.
QEMU_SRC="$(cd "$HERE/../qemu" && pwd)"

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

# QEMU supplies its own emscripten machine file (configs/meson/emscripten.txt)
# and meson loads it *after* the one configure generates from our LDFLAGS, so
# it replaces c_link_args wholesale - anything we exported is silently dropped.
# Take QEMU's list verbatim and append only what we need on top, so this
# survives upstream changing its own flags.
#
# stdin-proxy.js gives the console a keyboard: QEMU's fd 0 lives on the worker
# that -sPROXY_TO_PTHREAD puts main() on, while keystrokes arrive on the
# browser main thread, so the read and poll paths are proxied across.
#
# display-canvas.js is the same trick for the other direction: the VIDC20
# surface is pushed out to a canvas on the browser main thread, because
# the emscripten build has no display backend and runs -display none.
#
# XTERM_PTY=1 instead links xterm-pty, which would add full termios handling,
# but it is incompatible with -sPROXY_TO_PTHREAD (its PTY object is
# main-thread-only and it does not proxy reads) and dropping that flag makes
# QEMU block the browser main thread and freeze the tab. Kept for reference.
LINK_ARGS="$(python3 - "$QEMU_SRC/configs/meson/emscripten.txt" <<'PY'
import ast, re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^c_link_args = (\[.*?\])$", text, re.M)
print(" ".join(ast.literal_eval(m.group(1))))
PY
) --js-library $HERE/stdin-proxy.js --js-library $HERE/display-canvas.js"
if [ "${XTERM_PTY:-0}" = 1 ]; then
    LINK_ARGS="${LINK_ARGS//-sPROXY_TO_PTHREAD=1/} --js-library $HERE/emscripten-pty.js"
fi

"$OUT/pyvenv/bin/meson" configure "$OUT" -Dc_link_args="$LINK_ARGS"

emmake make -j"$JOBS"

# emcc indents bodies imported from --js-library, including otherwise blank
# lines. Keep the committed generated loader free of trailing whitespace while
# preserving byte-for-byte reproducibility through this build script.
sed -i 's/[[:blank:]]*$//' qemu-system-arm.js

echo "=== artifacts:"
ls -lh qemu-system-arm* 2>/dev/null || true
