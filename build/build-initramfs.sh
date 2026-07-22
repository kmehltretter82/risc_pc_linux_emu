#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0
# Build the static ARMv4 BusyBox initramfs shipped in assets/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINUX_WORK_ROOT="${LINUX_WORK_ROOT:-$HOME/linux-work}"
BUSYBOX_TARBALL="${BUSYBOX_TARBALL:-$LINUX_WORK_ROOT/buildroot/dl/busybox/busybox-1.38.0.tar.bz2}"
ARMV4_CROSS_COMPILE="${ARMV4_CROSS_COMPILE:-$LINUX_WORK_ROOT/armv4-tc-gcc8/bin/arm-linux-musleabi-}"
INITRAMFS_OUTPUT="${INITRAMFS_OUTPUT:-$SCRIPT_DIR/out/initramfs-busybox.cpio.gz}"
INITRAMFS_EPOCH="${SOURCE_DATE_EPOCH:-0}"
BUSYBOX_SHA256="34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2"

if [[ ! -f "$BUSYBOX_TARBALL" ]]; then
    echo "BusyBox 1.38.0 tarball not found: $BUSYBOX_TARBALL" >&2
    echo "Download https://busybox.net/downloads/busybox-1.38.0.tar.bz2" >&2
    echo "or set BUSYBOX_TARBALL to its location." >&2
    exit 1
fi

if [[ ! -x "${ARMV4_CROSS_COMPILE}gcc" ]]; then
    echo "ARMv4 compiler not found: ${ARMV4_CROSS_COMPILE}gcc" >&2
    echo "Set ARMV4_CROSS_COMPILE to the strict ARMv4 musl toolchain prefix." >&2
    exit 1
fi

actual_sha256="$(sha256sum "$BUSYBOX_TARBALL" | cut -d' ' -f1)"
if [[ "$actual_sha256" != "$BUSYBOX_SHA256" ]]; then
    echo "BusyBox tarball checksum mismatch:" >&2
    echo "  expected $BUSYBOX_SHA256" >&2
    echo "  actual   $actual_sha256" >&2
    exit 1
fi

if [[ -z "${JOBS:-}" ]]; then
    JOBS="$(nproc)"
fi

build_tmp="$(mktemp -d /tmp/riscpc-initramfs.XXXXXX)"
output_tmp=""
cleanup()
{
    rm -rf -- "$build_tmp"
    if [[ -n "$output_tmp" ]]; then
        rm -f -- "$output_tmp"
    fi
}
trap cleanup EXIT

busybox_src="$build_tmp/busybox"
initramfs_root="$build_tmp/root"
mkdir -p "$busybox_src" "$initramfs_root"
tar -xf "$BUSYBOX_TARBALL" -C "$busybox_src" --strip-components=1
cp "$SCRIPT_DIR/busybox-1.38.0.config" "$busybox_src/.config"

# Fail if BusyBox would silently rewrite the recorded configuration.
config_sha256="$(sha256sum "$busybox_src/.config" | cut -d' ' -f1)"
if ! KCONFIG_NOTIMESTAMP=1 make -s -C "$busybox_src" oldconfig </dev/null \
    >"$build_tmp/oldconfig.log" 2>&1; then
    echo "BusyBox oldconfig failed:" >&2
    sed -n '1,240p' "$build_tmp/oldconfig.log" >&2
    exit 1
fi
resolved_sha256="$(sha256sum "$busybox_src/.config" | cut -d' ' -f1)"
if [[ "$resolved_sha256" != "$config_sha256" ]]; then
    echo "BusyBox configuration changed during oldconfig; update the recorded config." >&2
    exit 1
fi

build_timestamp="$(date -u --date="@$INITRAMFS_EPOCH" '+%Y-%m-%d %H:%M:%S UTC')"
if ! KBUILD_BUILD_TIMESTAMP="$build_timestamp" \
    make -s -C "$busybox_src" -j"$JOBS" \
    CROSS_COMPILE="$ARMV4_CROSS_COMPILE" \
    >"$build_tmp/build.log" 2>&1; then
    echo "BusyBox build failed:" >&2
    sed -n '1,240p' "$build_tmp/build.log" >&2
    exit 1
fi

install -d -m 0755 \
    "$initramfs_root/bin" \
    "$initramfs_root/dev" \
    "$initramfs_root/etc" \
    "$initramfs_root/proc" \
    "$initramfs_root/sbin" \
    "$initramfs_root/sys" \
    "$initramfs_root/usr" \
    "$initramfs_root/usr/bin" \
    "$initramfs_root/usr/sbin"
install -d -m 0700 "$initramfs_root/root"
install -d -m 1777 "$initramfs_root/tmp"
install -m 0755 "$busybox_src/busybox" "$initramfs_root/bin/busybox"
ln -s busybox "$initramfs_root/bin/sh"
install -m 0755 "$SCRIPT_DIR/initramfs-init" "$initramfs_root/init"

output_dir="$(dirname "$INITRAMFS_OUTPUT")"
mkdir -p "$output_dir"
output_tmp="$(mktemp "$output_dir/.initramfs-busybox.XXXXXX")"
"$SCRIPT_DIR/gen-initramfs.py" "$initramfs_root" "$INITRAMFS_EPOCH" \
    | gzip -9n >"$output_tmp"
mv -f -- "$output_tmp" "$INITRAMFS_OUTPUT"
output_tmp=""

echo "Built $INITRAMFS_OUTPUT"
sha256sum "$INITRAMFS_OUTPUT"
md5sum "$INITRAMFS_OUTPUT"
file "$busybox_src/busybox"
