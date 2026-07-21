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
# emscripten-pty.js (from xterm-pty) is a *link-time* JS library, not a runtime
# script: it overrides emscripten's TTY ops so QEMU's "-serial stdio" reads and
# writes a real pty backed by the xterm.js terminal in the page, with working
# termios and blocking reads. Without it the guest's console output goes to
# console.log instead of the terminal.
#
# XTERM_PTY=1 links xterm-pty's TTY override, which would give a real pty
# (termios, blocking reads, therefore keyboard input). It is off by default
# because it is incompatible with QEMU's -sPROXY_TO_PTHREAD: that runs main()
# in a worker, while Module.pty is a live object on the main thread that
# cannot be cloned into one, so the pty ops find no PTY and the console goes
# nowhere. Dropping PROXY_TO_PTHREAD instead makes QEMU block the browser
# main thread and freeze the tab. Until stdin is proxied worker->main, guest
# output reaches the page through emscripten's own stdout proxying and the
# console is read-only.
LINK_ARGS="$(python3 - "$QEMU_SRC/configs/meson/emscripten.txt" <<'PY'
import ast, re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^c_link_args = (\[.*?\])$", text, re.M)
print(" ".join(ast.literal_eval(m.group(1))))
PY
)"
if [ "${XTERM_PTY:-0}" = 1 ]; then
    LINK_ARGS="${LINK_ARGS//-sPROXY_TO_PTHREAD=1/} --js-library $HERE/emscripten-pty.js"
fi

"$OUT/pyvenv/bin/meson" configure "$OUT" -Dc_link_args="$LINK_ARGS"

emmake make -j"$(nproc)"
echo "=== artifacts:"
ls -lh qemu-system-arm* 2>/dev/null || true
