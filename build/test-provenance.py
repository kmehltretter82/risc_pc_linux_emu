#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0
"""Verify that every shipped binary has accurate, pinned provenance."""

import hashlib
import re
import subprocess
import sys
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent.parent
README_PATH = PROJECT_DIR / "assets" / "README.md"
BINARY_ASSETS = {
    "zImage": PROJECT_DIR / "assets" / "zImage",
    "zImage-7.1.4": PROJECT_DIR / "assets" / "zImage-7.1.4",
    "zImage-netwinder": PROJECT_DIR / "assets" / "zImage-netwinder",
    "initramfs-busybox.cpio.gz": (
        PROJECT_DIR / "assets" / "initramfs-busybox.cpio.gz"
    ),
    "qemu/qemu-system-arm.wasm": (
        PROJECT_DIR / "assets" / "qemu" / "qemu-system-arm.wasm"
    ),
    "qemu/qemu-system-arm.js": (
        PROJECT_DIR / "assets" / "qemu" / "qemu-system-arm.js"
    ),
}
BUSYBOX_BUILD_FILES = (
    "build/build-initramfs.sh",
    "build/busybox-1.38.0.config",
    "build/gen-initramfs.py",
    "build/initramfs-init",
    "build/musl-cross-make-armv4.config",
    "build/musl-1.2.6-armv4.patch",
)


def md5(path):
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def table_row(readme, label):
    prefix = f"| `{label}` |"
    return next((line for line in readme.splitlines() if line.startswith(prefix)), None)


def submodule_commit(name):
    checkout = PROJECT_DIR / name
    if (checkout / ".git").exists():
        command = ("git", "-C", str(checkout), "rev-parse", "HEAD")
    else:
        command = ("git", "-C", str(PROJECT_DIR), "rev-parse", f"HEAD:{name}")
    return subprocess.check_output(command, text=True).strip()


def main():
    readme = README_PATH.read_text()
    errors = []

    for label, path in BINARY_ASSETS.items():
        row = table_row(readme, label)
        if row is None:
            errors.append(f"{label}: no provenance table row")
            continue
        documented = re.search(r"md5 `([0-9a-f]{32})`", row)
        if documented is None:
            errors.append(f"{label}: table row has no md5 checksum")
            continue
        actual = md5(path)
        if documented.group(1) != actual:
            errors.append(
                f"{label}: md5 is {actual}, documented as {documented.group(1)}"
            )

    for name in ("linux", "qemu"):
        commit = submodule_commit(name)
        if commit not in readme:
            errors.append(f"{name}: submodule commit {commit} is absent from README")

    build_script = (PROJECT_DIR / "build" / "build-initramfs.sh").read_text()
    match = re.search(r'^BUSYBOX_SHA256="([0-9a-f]{64})"$', build_script, re.MULTILINE)
    if match is None:
        errors.append("build-initramfs.sh: BUSYBOX_SHA256 is missing")
    elif match.group(1) not in readme:
        errors.append("BusyBox source SHA-256 is absent from README")

    for relative in BUSYBOX_BUILD_FILES:
        if relative not in readme:
            errors.append(f"BusyBox provenance does not name {relative}")

    if errors:
        print("Asset provenance check failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    print(f"Asset provenance: PASS ({len(BINARY_ASSETS)} binaries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
