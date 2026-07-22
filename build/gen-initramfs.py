#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0
"""Write a deterministic newc initramfs, including /dev/console."""

import os
import stat
import sys
from pathlib import Path


def pad4(stream, size):
    stream.write(b"\0" * (-size % 4))


def write_entry(stream, inode, name, mode, data=b"", rdev=(0, 0), mtime=0):
    encoded_name = name.encode() + b"\0"
    fields = (
        inode,
        mode,
        0,  # uid
        0,  # gid
        2 if stat.S_ISDIR(mode) else 1,
        mtime,
        len(data),
        0,  # devmajor
        0,  # devminor
        rdev[0],
        rdev[1],
        len(encoded_name),
        0,  # checksum, unused by newc
    )
    header = b"070701" + b"".join(f"{value:08x}".encode() for value in fields)
    stream.write(header)
    stream.write(encoded_name)
    pad4(stream, len(header) + len(encoded_name))
    stream.write(data)
    pad4(stream, len(data))


def archive_entries(root):
    entries = []
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        info = path.lstat()
        mode = info.st_mode
        if stat.S_ISREG(mode):
            data = path.read_bytes()
        elif stat.S_ISLNK(mode):
            data = os.readlink(path).encode()
        elif stat.S_ISDIR(mode):
            data = b""
        else:
            raise ValueError(f"unsupported initramfs entry: {path}")
        entries.append((relative, mode, data, (0, 0)))

    entries.append(("dev/console", stat.S_IFCHR | 0o600, b"", (5, 1)))
    return sorted(entries, key=lambda entry: entry[0].encode())


def main():
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} ROOT SOURCE_DATE_EPOCH")

    root = Path(sys.argv[1]).resolve()
    epoch = int(sys.argv[2])
    output = sys.stdout.buffer
    inode = 1

    for name, mode, data, rdev in archive_entries(root):
        write_entry(output, inode, name, mode, data, rdev, epoch)
        inode += 1

    write_entry(output, inode, "TRAILER!!!", 0, mtime=epoch)


if __name__ == "__main__":
    main()
