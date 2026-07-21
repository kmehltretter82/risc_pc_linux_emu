#!/usr/bin/env bash
# Cross-compile QEMU's dependencies with Emscripten, following
# qemu/tests/docker/dockerfiles/emsdk-wasm64-cross.docker step by step.
# Differences from the dockerfile: release tarballs instead of git clones
# (no autotools needed on the host), and meson from a venv instead of pip3.
set -euo pipefail

ZLIB_VERSION=1.3.2
GLIB_MINOR_VERSION=2.84
GLIB_VERSION=${GLIB_MINOR_VERSION}.0
PIXMAN_VERSION=0.44.2
FFI_VERSION=3.5.2
MESON_VERSION=1.5.0

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPS="$HERE/deps"
SRC="$DEPS/src"
mkdir -p "$DEPS" "$SRC"

# meson venv (dockerfile: pip3 install meson tomli)
if [ ! -x "$DEPS/venv/bin/meson" ]; then
    python3 -m venv "$DEPS/venv"
    "$DEPS/venv/bin/pip" -q install "meson==$MESON_VERSION" tomli
fi

source "$HERE/env.sh"
mkdir -p "$TARGET"

cross_meson() {  # $1 = output file; CFLAGS/LDFLAGS from env
    cat > "$1" <<EOT
[host_machine]
system = 'emscripten'
cpu_family = 'wasm64'
cpu = 'wasm64'
endian = 'little'

[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkgconfig = ['pkg-config', '--static']

[built-in options]
c_args = [$(printf "'%s', " $CFLAGS | sed 's/, $//')]
cpp_args = [$(printf "'%s', " $CFLAGS | sed 's/, $//')]
objc_args = [$(printf "'%s', " $CFLAGS | sed 's/, $//')]
c_link_args = [$(printf "'%s', " $LDFLAGS | sed 's/, $//')]
cpp_link_args = [$(printf "'%s', " $LDFLAGS | sed 's/, $//')]
EOT
}

fetch() {  # $1 = url, $2 = destdir
    mkdir -p "$2"
    curl -Ls --fail --retry 3 --connect-timeout 20 --max-time 600 "$1" |
        tar xJC "$2" --strip-components=1
}

echo "=== zlib $ZLIB_VERSION"
if [ ! -e "$TARGET/lib/libz.a" ]; then
    fetch "https://zlib.net/zlib-$ZLIB_VERSION.tar.xz" "$SRC/zlib" ||
    fetch "https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.xz" "$SRC/zlib"
    (cd "$SRC/zlib" &&
     emconfigure ./configure --prefix="$TARGET" --static &&
     emmake make install -j"$JOBS")
fi

echo "=== libffi $FFI_VERSION"
if [ ! -e "$TARGET/lib/libffi.a" ]; then
    mkdir -p "$SRC/libffi"
    curl -Ls --fail --retry 3 --connect-timeout 20 --max-time 600 \
        "https://github.com/libffi/libffi/releases/download/v$FFI_VERSION/libffi-$FFI_VERSION.tar.gz" |
        tar xzC "$SRC/libffi" --strip-components=1
    (cd "$SRC/libffi" &&
     emconfigure ./configure --host=wasm64-unknown-linux \
        --prefix="$TARGET" --enable-static \
        --disable-shared --disable-dependency-tracking \
        --disable-builddir --disable-multi-os-directory \
        --disable-raw-api --disable-docs &&
     emmake make install SUBDIRS='include' -j"$JOBS")
fi

echo "=== pixman $PIXMAN_VERSION"
if [ ! -e "$TARGET/lib/libpixman-1.a" ]; then
    fetch "https://www.x.org/releases/individual/lib/pixman-$PIXMAN_VERSION.tar.xz" "$SRC/pixman"
    cross_meson "$SRC/pixman/cross.meson"
    (cd "$SRC/pixman" &&
     meson setup _build --prefix="$TARGET" --cross-file=cross.meson \
        --default-library=static \
        --buildtype=release -Dtests=disabled -Ddemos=disabled &&
     meson install -C _build)
fi

echo "=== glib $GLIB_VERSION"
if [ ! -e "$TARGET/lib/libglib-2.0.a" ]; then
    # res_query stub (dockerfile builds the same)
    mkdir -p "$SRC/stub"
    cat > "$SRC/stub/res_query.c" <<'EOT'
#include <netdb.h>
int res_query(const char *name, int class,
              int type, unsigned char *dest, int len)
{
    h_errno = HOST_NOT_FOUND;
    return -1;
}
EOT
    (cd "$SRC/stub" &&
     emcc $CFLAGS -c res_query.c -fPIC -o libresolv.o &&
     emar rcs libresolv.a libresolv.o &&
     cp libresolv.a "$TARGET/lib/")

    fetch "https://download.gnome.org/sources/glib/$GLIB_MINOR_VERSION/glib-$GLIB_VERSION.tar.xz" "$SRC/glib"
    CFLAGS="$CFLAGS -Wno-incompatible-function-pointer-types" \
        cross_meson "$SRC/glib/cross.meson"
    # -Dlibelf=disabled: not in the upstream dockerfile, needed here because
    # meson otherwise picks up the *host* libelf (the emsdk image has none)
    # and gio/gresource-tool.c then fails on a missing libelf.h.
    (cd "$SRC/glib" &&
     meson setup _build $([ -d _build ] && echo --reconfigure) \
        --prefix="$TARGET" --cross-file=cross.meson \
        --default-library=static --buildtype=release --force-fallback-for=pcre2 \
        -Dselinux=disabled -Dxattr=false -Dlibmount=disabled -Dnls=disabled \
        -Dtests=false -Dglib_debug=disabled -Dglib_assert=false -Dglib_checks=false \
        -Dlibelf=disabled -Dsysprof=disabled &&
     # dockerfile FIXME: emscripten lacks these at final link
     sed -i -E "/#define HAVE_POSIX_SPAWN 1/d" _build/config.h &&
     sed -i -E "/#define HAVE_PTHREAD_GETNAME_NP 1/d" _build/config.h &&
     meson install -C _build)
fi

echo "=== deps done: $TARGET"
