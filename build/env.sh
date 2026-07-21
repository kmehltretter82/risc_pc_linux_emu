# Build environment for the Emscripten wasm64 QEMU build.
# Mirrors qemu/tests/docker/dockerfiles/emsdk-wasm64-cross.docker
# (emsdk 4.0.10, meson 1.5.0; deps: zlib 1.3.2, libffi 3.5.2, pixman 0.44.2,
#  glib 2.84.0). Source this file; do not execute it.

EMSDK_ROOT="${EMSDK_ROOT:-$HOME/linux-work/emsdk}"
BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPS="$BUILD_DIR/deps"
export TARGET="$DEPS/target"

source "$EMSDK_ROOT/emsdk_env.sh" >/dev/null
export PATH="$DEPS/venv/bin:$PATH"

export CPATH="$TARGET/include"
export PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
# LIBDIR (not just PATH) — PKG_CONFIG_PATH only *prepends* to the default
# search dirs, so host packages still leak in. The upstream dockerfile gets
# away without this because the emsdk image has no -dev packages installed;
# on a developer box, meson otherwise finds host libelf/sysprof and tries to
# link x86 archives into wasm.
export PKG_CONFIG_LIBDIR="$TARGET/lib/pkgconfig"
export CFLAGS="-O3 -pthread -DWASM_BIGINT -sMEMORY64=1"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-sWASM_BIGINT -sASYNCIFY=1 -sMEMORY64=1 -L$TARGET/lib"
