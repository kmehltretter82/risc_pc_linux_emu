#!/usr/bin/env bash
# Build QEMU to WebAssembly. By default this uses the qemu submodule and its
# native Wasm TCG backend. QEMU_TCG_BACKEND=tci retains the interpreted
# fallback; QEMU_SRC_OVERRIDE and QEMU_BUILD_OUT permit clean side builds.
# Configure options mirror .gitlab-ci.d job build-wasm64-32bit: wasm64
# objects with a 32-bit address limit, which suits a 32-bit ARM guest.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
QEMU_BUILD_OUT="${QEMU_BUILD_OUT:-$HERE/out}"

DEPS_TOOLCHAIN_STAMP="$DEPS/.emscripten-version"
if [ ! -f "$DEPS_TOOLCHAIN_STAMP" ] ||
        [ "$(cat "$DEPS_TOOLCHAIN_STAMP" 2>/dev/null)" != "$QEMU_EMSDK_VERSION" ]; then
    echo "Dependencies stamped for Emscripten $QEMU_EMSDK_VERSION are required." >&2
    echo "Run build/build-deps.sh first, using a fresh WASM_DEPS_DIR if needed." >&2
    exit 1
fi

# Link flags beyond the dependency ones: upstream only ever *builds* the wasm
# binary in CI, it never runs it, so nothing there makes the module loadable
# from JS. FS/NODEFS let a node wrapper mount host files for Milestone A and
# let the browser write fetched images into MEMFS; callMain lets the page
# start QEMU with its own argv.
QEMU_SRC_DEFAULT="$(cd "$HERE/../qemu" && pwd)"
QEMU_SRC="${QEMU_SRC_OVERRIDE:-$QEMU_SRC_DEFAULT}"
QEMU_SRC="$(cd "$QEMU_SRC" && pwd)"

if "$QEMU_SRC/configure" --help | \
        grep -F -- '--enable-wasm64-32bit-address-limit' >/dev/null; then
    QEMU_WASM_LIMIT_OPTION=--enable-wasm64-32bit-address-limit
else
    QEMU_WASM_LIMIT_OPTION=--wasm64-32bit-address-limit
fi

QEMU_TCG_BACKEND="${QEMU_TCG_BACKEND:-wasm}"
case "$QEMU_TCG_BACKEND" in
    tci)
        QEMU_TCG_OPTION=--enable-tcg-interpreter
        QEMU_TCG_INTERPRETER=true
        ;;
    wasm)
        QEMU_TCG_OPTION=--disable-tcg-interpreter
        QEMU_TCG_INTERPRETER=false
        ;;
    *)
        echo "QEMU_TCG_BACKEND must be 'tci' or 'wasm'" >&2
        exit 2
        ;;
esac

mkdir -p "$QEMU_BUILD_OUT"
cd "$QEMU_BUILD_OUT"

if [ ! -e config-host.mak ]; then
    emconfigure "$QEMU_SRC/configure" --disable-docs \
        --target-list=arm-softmmu \
        --static --cpu=wasm64 "$QEMU_WASM_LIMIT_OPTION" \
        --disable-tools "$QEMU_TCG_OPTION" \
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
) --js-library $HERE/stdin-proxy.js --js-library $HERE/display-canvas.js -lidbfs.js"
if [ "${XTERM_PTY:-0}" = 1 ]; then
    LINK_ARGS="${LINK_ARGS//-sPROXY_TO_PTHREAD=1/} --js-library $HERE/emscripten-pty.js"
fi

"$QEMU_BUILD_OUT/pyvenv/bin/meson" configure "$QEMU_BUILD_OUT" \
    -Dtcg_interpreter="$QEMU_TCG_INTERPRETER" \
    -Dwasm64_32bit_address_limit=true \
    -Dc_link_args="$LINK_ARGS"

emmake make -j"$JOBS"

# emcc indents bodies imported from --js-library, including otherwise blank
# lines. Keep the committed generated loader free of trailing whitespace while
# preserving byte-for-byte reproducibility through this build script.
sed -i 's/[[:blank:]]*$//' qemu-system-arm.js

echo "=== artifacts:"
ls -lh qemu-system-arm* 2>/dev/null || true
