#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0
# Build the patched NetBSD/acorn32 kernel and an unprivileged FFS root image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NETBSD_VERSION=10.1
NETBSD_MIRROR="${NETBSD_MIRROR:-https://cdn.netbsd.org/pub/NetBSD/NetBSD-${NETBSD_VERSION}}"
NETBSD_BUILD_ROOT="${NETBSD_BUILD_ROOT:-$SCRIPT_DIR/out/netbsd-${NETBSD_VERSION}}"
NETBSD_HOST_CC="${NETBSD_HOST_CC:-gcc-14}"
NETBSD_IMAGE_SIZE="${NETBSD_IMAGE_SIZE:-384m}"
NETBSD_IMAGE_EPOCH="${SOURCE_DATE_EPOCH:-1734354480}"

if [[ -z "${JOBS:-}" ]]; then
    JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1\n')"
fi

for tool in basename chmod curl cut dirname install mkdir mktemp mv patch \
    rm sed sha512sum tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Required host tool not found: $tool" >&2
        exit 1
    fi
done

if ! command -v "$NETBSD_HOST_CC" >/dev/null 2>&1; then
    echo "NetBSD host compiler not found: $NETBSD_HOST_CC" >&2
    echo "NetBSD 10.1's host tools are incompatible with GCC 15/C23." >&2
    echo "Install GCC 14 or set NETBSD_HOST_CC to a compatible compiler." >&2
    exit 1
fi
NETBSD_HOST_CC="$(command -v "$NETBSD_HOST_CC")"

mkdir -p "$NETBSD_BUILD_ROOT"
NETBSD_BUILD_ROOT="$(cd "$NETBSD_BUILD_ROOT" && pwd)"
DOWNLOAD_DIR="$NETBSD_BUILD_ROOT/downloads"
SET_DIR="$NETBSD_BUILD_ROOT/sets/acorn32"
SOURCE_DIR="$NETBSD_BUILD_ROOT/src"
OBJECT_DIR="$NETBSD_BUILD_ROOT/obj"
TOOLS_DIR="$NETBSD_BUILD_ROOT/tools"
NETBSD_IMAGE="${NETBSD_IMAGE:-$NETBSD_BUILD_ROOT/netbsd-${NETBSD_VERSION}-riscpc.ffs}"
NETBSD_KERNEL="${NETBSD_KERNEL:-$NETBSD_BUILD_ROOT/netbsd-GENERIC}"

mkdir -p "$DOWNLOAD_DIR" "$SET_DIR" "$SOURCE_DIR" \
    "$(dirname "$NETBSD_IMAGE")" "$(dirname "$NETBSD_KERNEL")"

download_tmp=""
root_tmp=""
spec_tmp=""
image_tmp=""
kernel_tmp=""
cleanup()
{
    if [[ -n "$download_tmp" ]]; then
        rm -f -- "$download_tmp"
    fi
    if [[ -n "$root_tmp" ]]; then
        rm -rf -- "$root_tmp"
    fi
    if [[ -n "$spec_tmp" ]]; then
        rm -f -- "$spec_tmp"
    fi
    if [[ -n "$image_tmp" ]]; then
        rm -f -- "$image_tmp"
    fi
    if [[ -n "$kernel_tmp" ]]; then
        rm -f -- "$kernel_tmp"
    fi
}
trap cleanup EXIT

verify_sha512()
{
    local path="$1"
    local expected="$2"
    local actual

    actual="$(sha512sum "$path" | cut -d' ' -f1)"
    if [[ "$actual" != "$expected" ]]; then
        echo "SHA-512 mismatch for $path" >&2
        echo "  expected $expected" >&2
        echo "  actual   $actual" >&2
        return 1
    fi
}

fetch_verified()
{
    local path="$1"
    local url="$2"
    local expected="$3"

    if [[ ! -f "$path" ]]; then
        download_tmp="$(mktemp "$(dirname "$path")/.download.XXXXXX")"
        echo "Downloading $url"
        curl --fail --location --retry 3 --output "$download_tmp" "$url"
        verify_sha512 "$download_tmp" "$expected"
        mv -- "$download_tmp" "$path"
        download_tmp=""
    fi
    verify_sha512 "$path" "$expected"
}

SOURCE_URL="$NETBSD_MIRROR/source/sets"
fetch_verified "$DOWNLOAD_DIR/gnusrc.tgz" "$SOURCE_URL/gnusrc.tgz" \
    8a1c42030ba44eb2a0c7a5111187bc02e8f4d0860d8491b7863579e612333665c478625c37b01f08732e3cfd29ec31335f1db1274fd7dcfdc048b09d1b4bbb83
fetch_verified "$DOWNLOAD_DIR/sharesrc.tgz" "$SOURCE_URL/sharesrc.tgz" \
    703eeb306fc0328cad7e6f0e100d2e7af194f82e613338f4611a7bcd5f6d773d8789e7ce03ec25268ec2b95ccdb97c3b4289a838a629716498b4d7c3184cb1ef
fetch_verified "$DOWNLOAD_DIR/src.tgz" "$SOURCE_URL/src.tgz" \
    6ae2053b4b75821238c0757d4f7258daece425de72524c616e07d3adee7c48d87422dd47d852a137918cec3dd3c0d339e372f4504dfe9f1bc5520011775bdb86
fetch_verified "$DOWNLOAD_DIR/syssrc.tgz" "$SOURCE_URL/syssrc.tgz" \
    766ac21f33cfe0e701dfedb894fa07f36d811da1a12e979181e8fca7af4e627852680ce42a7b29e97dd3e2e402ddf9ae7bfba60c8d7dc6b8a3354d8ce8c06926

if [[ ! -x "$SOURCE_DIR/build.sh" ]]; then
    echo "Extracting NetBSD ${NETBSD_VERSION} source sets"
    for source_set in gnusrc sharesrc src syssrc; do
        tar -xzf "$DOWNLOAD_DIR/${source_set}.tgz" \
            -C "$SOURCE_DIR" --strip-components=2
    done
fi

if [[ ! -x "$SOURCE_DIR/build.sh" ||
      ! -d "$SOURCE_DIR/sys/arch/acorn32" ]]; then
    echo "NetBSD source extraction is incomplete: $SOURCE_DIR" >&2
    exit 1
fi

apply_patch_once()
{
    local patch_file="$1"

    if patch --batch --forward --dry-run -d "$SOURCE_DIR" -p1 \
        <"$patch_file" >/dev/null 2>&1; then
        patch --batch --forward -d "$SOURCE_DIR" -p1 <"$patch_file"
    elif patch --batch --reverse --dry-run -d "$SOURCE_DIR" -p1 \
        <"$patch_file" >/dev/null 2>&1; then
        echo "Already applied: $(basename "$patch_file")"
    else
        echo "Patch neither applies nor reverses cleanly: $patch_file" >&2
        exit 1
    fi
}

apply_patch_once \
    "$REPO_ROOT/patches/netbsd/0001-acorn32-iomd-ignore-zero-statclock-rate.patch"
apply_patch_once \
    "$REPO_ROOT/patches/netbsd/0002-iomd-align-intrnames-pointer.patch"

build_args=(
    -U
    -P
    -m acorn32
    -u
    -O "$OBJECT_DIR"
    -T "$TOOLS_DIR"
    -j"$JOBS"
    -V "HOST_CC=$NETBSD_HOST_CC"
    -V MAKEVERBOSE=0
)

echo "Building NetBSD/acorn32 host tools with $NETBSD_HOST_CC"
(
    cd "$SOURCE_DIR"
    ./build.sh "${build_args[@]}" tools
)

echo "Building patched NetBSD/acorn32 GENERIC kernel"
(
    cd "$SOURCE_DIR"
    ./build.sh "${build_args[@]}" kernel=GENERIC
)

built_kernel="$OBJECT_DIR/sys/arch/acorn32/compile/GENERIC/netbsd"
if [[ ! -f "$built_kernel" ]]; then
    echo "NetBSD kernel was not produced: $built_kernel" >&2
    exit 1
fi

kernel_tmp="$(mktemp "$(dirname "$NETBSD_KERNEL")/.netbsd-GENERIC.XXXXXX")"
install -m 0555 "$built_kernel" "$kernel_tmp"
mv -f -- "$kernel_tmp" "$NETBSD_KERNEL"
kernel_tmp=""

BINARY_URL="$NETBSD_MIRROR/acorn32/binary/sets"
fetch_verified "$SET_DIR/base.tgz" "$BINARY_URL/base.tgz" \
    c6581570e74914b06a2b425e808ad11cc34fa5e5e71c441bd2ff81561c544edfe0c05b94cbedfd5d5260507f8185d8766121a5f1ced5cd85e5777fa12dfe7f37
fetch_verified "$SET_DIR/etc.tgz" "$BINARY_URL/etc.tgz" \
    1c3d875a5d978730b3d11b7d90b6fcd8a666d56c2f43877b9ab9006672afd37daaaef2a3300c8b73117a3e5656abf577444e60f6a38490dfe9135afacc48d115
fetch_verified "$SET_DIR/rescue.tgz" "$BINARY_URL/rescue.tgz" \
    e6aea28b0bfa1d11af5ff821aab9d73e376b48364797372eabe653f1ddc09a65a0dbea61f97d47459ae7a7b095eeaee3b66929b6302f8f411cdd076b9fc72025

root_tmp="$(mktemp -d "$NETBSD_BUILD_ROOT/.rootfs.XXXXXX")"
for binary_set in base etc rescue; do
    tar -xzpf "$SET_DIR/${binary_set}.tgz" -C "$root_tmp"
done

spec_tmp="$(mktemp "$NETBSD_BUILD_ROOT/.makefs-spec.XXXXXX")"
for mtree_file in "$root_tmp"/etc/mtree/*; do
    sed -e 's/ size=[0-9][0-9]*//' "$mtree_file" >>"$spec_tmp"
done
(
    cd "$root_tmp/dev"
    HOST_SH=/bin/sh ./MAKEDEV -s all
) | sed -e '/^\. type=dir/d' -e 's,^\.,./dev,' >>"$spec_tmp"

# This intentionally unreadable FTP directory is the one file makefs must read
# from the host in order to place it in the image.
chmod u+r "$root_tmp/var/spool/ftp/hidden"

image_tmp="$(mktemp "$(dirname "$NETBSD_IMAGE")/.netbsd-riscpc.XXXXXX")"
"$TOOLS_DIR/bin/nbmakefs" \
    -F "$spec_tmp" \
    -N "$root_tmp/etc" \
    -T "$NETBSD_IMAGE_EPOCH" \
    -t ffs \
    -o version=1,bsize=8192,fsize=1024,label=netbsd \
    -s "$NETBSD_IMAGE_SIZE" \
    "$image_tmp" "$root_tmp"
mv -f -- "$image_tmp" "$NETBSD_IMAGE"
image_tmp=""
chmod 0644 "$NETBSD_IMAGE"

echo "Built NetBSD/acorn32 artifacts:"
echo "  kernel: $NETBSD_KERNEL"
echo "  rootfs: $NETBSD_IMAGE"
sha512sum "$NETBSD_KERNEL" "$NETBSD_IMAGE"
