#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0
"""Boot the generated NetBSD image and prove that its root shell executes."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BUILD = REPO_ROOT / "build" / "out" / "netbsd-10.1"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Boot NetBSD/acorn32, answer its framebuffer prompts, and "
            "require a marker and uname output from the userland root shell."
        )
    )
    parser.add_argument(
        "--qemu",
        type=Path,
        default=REPO_ROOT / "qemu" / "build" / "qemu-system-arm",
    )
    parser.add_argument(
        "--qemu-img",
        default=os.environ.get("QEMU_IMG", "qemu-img"),
        help="qemu-img executable used to make a disposable overlay",
    )
    parser.add_argument(
        "--kernel",
        type=Path,
        default=DEFAULT_BUILD / "netbsd-GENERIC",
    )
    parser.add_argument(
        "--image",
        type=Path,
        default=DEFAULT_BUILD / "netbsd-10.1-riscpc.ffs",
    )
    parser.add_argument(
        "--boot-wait",
        type=float,
        default=15.0,
        help="seconds to allow for the initial root-device prompt",
    )
    return parser.parse_args()


def require_file(path: Path, description: str) -> Path:
    path = path.resolve()
    if not path.is_file():
        raise SystemExit(f"{description} not found: {path}")
    return path


def send_hmp(process: subprocess.Popen[bytes], command: str) -> None:
    if process.poll() is not None:
        raise RuntimeError(f"QEMU exited early with status {process.returncode}")
    assert process.stdin is not None
    process.stdin.write(command.encode("ascii") + b"\n")
    process.stdin.flush()


def send_text(process: subprocess.Popen[bytes], text: str) -> None:
    key_names = {
        "\n": "ret",
        " ": "spc",
        "-": "minus",
        "/": "slash",
        ">": "shift-dot",
    }
    for character in text:
        if character in key_names:
            key = key_names[character]
        elif character.isascii() and character.isalnum():
            key = character.lower()
        else:
            raise ValueError(f"no HMP key mapping for {character!r}")
        send_hmp(process, f"sendkey {key}")
        time.sleep(0.12)


def fail_with_log(message: str, log_path: Path) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    try:
        log = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    if log:
        print("--- QEMU monitor log (tail) ---", file=sys.stderr)
        print(log[-4000:], file=sys.stderr)


def wait_for_serial(
    process: subprocess.Popen[bytes],
    serial_path: Path,
    expected: tuple[str, ...],
    timeout: float,
) -> str:
    deadline = time.monotonic() + timeout
    output = ""
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"QEMU exited early with status {process.returncode}")
        try:
            output = serial_path.read_text(encoding="ascii", errors="replace")
        except FileNotFoundError:
            pass
        if all(marker in output for marker in expected):
            return output
        time.sleep(0.2)
    missing = [marker for marker in expected if marker not in output]
    raise TimeoutError(f"serial markers not received: {', '.join(missing)}")


def main() -> int:
    args = parse_args()
    qemu = require_file(args.qemu, "qemu-system-arm")
    kernel = require_file(args.kernel, "NetBSD kernel")
    image = require_file(args.image, "NetBSD FFS image")
    qemu_img = shutil.which(args.qemu_img)
    if qemu_img is None:
        raise SystemExit(f"qemu-img not found: {args.qemu_img}")

    with tempfile.TemporaryDirectory(prefix="riscpc-netbsd-") as temp_name:
        temp_dir = Path(temp_name)
        overlay = temp_dir / "root.qcow2"
        log_path = temp_dir / "qemu-monitor.log"
        serial_path = temp_dir / "netbsd-serial.log"
        subprocess.run(
            [
                qemu_img,
                "create",
                "-q",
                "-f",
                "qcow2",
                "-F",
                "raw",
                "-b",
                str(image),
                str(overlay),
            ],
            check=True,
        )

        command = [
            str(qemu),
            "-M",
            "riscpc",
            "-m",
            "64M",
            "-kernel",
            str(kernel),
            "-drive",
            f"if=ide,file={overlay},format=qcow2",
            "-display",
            "none",
            "-serial",
            f"file:{serial_path}",
            "-monitor",
            "stdio",
            "-no-reboot",
        ]

        with log_path.open("wb") as log_file:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=log_file,
                stderr=subprocess.STDOUT,
            )
            try:
                time.sleep(args.boot_wait)
                send_text(process, "wd0a\n")
                time.sleep(1)
                send_text(process, "\n")  # default dump device
                time.sleep(1)
                send_text(process, "\n")  # default FFS root type
                time.sleep(2)
                send_text(process, "\n")  # default /sbin/init
                time.sleep(6)
                send_text(process, "\n")  # default /bin/sh after rc abort
                time.sleep(2)
                send_text(process, "echo netbsd-userland-ok >/dev/tty00\n")
                send_text(process, "uname -p >/dev/tty00\n")
                wait_for_serial(
                    process,
                    serial_path,
                    ("netbsd-userland-ok", "earmv4"),
                    timeout=15,
                )
                send_hmp(process, "quit")
                returncode = process.wait(timeout=5)
            except (
                BrokenPipeError,
                RuntimeError,
                TimeoutError,
                subprocess.TimeoutExpired,
            ) as error:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                fail_with_log(str(error), log_path)
                return 1

        if returncode != 0:
            fail_with_log(f"QEMU exited with status {returncode}", log_path)
            return 1

    print("PASS: NetBSD/acorn32 root shell reported earmv4 over the UART")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
